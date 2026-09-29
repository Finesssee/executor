package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWorkerd serves HTTP/1.1 on a Unix socket with kj's keep-alive rule: once a
// response completes, the connection closes if no request starts within the
// idle timeout. A request arriving at that moment is dropped unread, which is
// the race a pooled proxy connection can lose.
type fakeWorkerd struct {
	idleTimeout time.Duration
	// dropFirst closes a fresh connection after reading its request, without a response.
	dropFirst bool
	received  atomic.Int32
	handled   atomic.Int32
}

func (f *fakeWorkerd) serve(t *testing.T, socket string) {
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go f.connection(conn)
		}
	}()
}

func (f *fakeWorkerd) connection(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for first := true; ; first = false {
		idleSince := time.Now()
		if _, err := reader.Peek(1); err != nil {
			return
		}
		if !first && time.Since(idleSince) >= f.idleTimeout {
			return
		}
		request, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		if _, err = io.Copy(io.Discard, request.Body); err != nil {
			return
		}
		f.received.Add(1)
		if f.dropFirst && first {
			return
		}
		f.handled.Add(1)
		if _, err = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); err != nil {
			return
		}
	}
}

func socketPath(t *testing.T) string {
	// Unix socket paths are limited to about 100 bytes, which t.TempDir can exceed on macOS.
	directory, err := os.MkdirTemp("", "proxy-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return filepath.Join(directory, "product.sock")
}

func post(t *testing.T, address string) (int, string) {
	t.Helper()
	response, err := http.Post(address+"/api/workflow-runs", "application/json", strings.NewReader(`{"key":"k"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, strings.TrimSpace(string(body))
}

func TestProxyDoesNotReuseConnectionsWorkerdHasTimedOut(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: 300 * time.Millisecond}
	upstream.serve(t, socket)
	front := httptest.NewServer(productProxy(socket, upstream.idleTimeout))
	defer front.Close()

	if status, body := post(t, front.URL); status != 200 {
		t.Fatalf("first POST: %d %s", status, body)
	}
	time.Sleep(upstream.idleTimeout + 100*time.Millisecond)
	if status, body := post(t, front.URL); status != 200 {
		t.Fatalf("POST after workerd's idle timeout: %d %s", status, body)
	}
	if handled := upstream.handled.Load(); handled != 2 {
		t.Fatalf("workerd handled %d POSTs, want 2", handled)
	}
}

func TestProxyDoesNotRetryPostWorkerdMayHaveReceived(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute, dropFirst: true}
	upstream.serve(t, socket)
	front := httptest.NewServer(productProxy(socket, upstream.idleTimeout))
	defer front.Close()

	status, body := post(t, front.URL)
	if status != http.StatusBadGateway || body == "Executor is starting" {
		t.Fatalf("dropped POST: %d %q, want 502 with the upstream failure", status, body)
	}
	if received := upstream.received.Load(); received != 1 {
		t.Fatalf("workerd received the POST %d times, want 1", received)
	}
}

func TestProxyReportsStartingUntilWorkerdListens(t *testing.T) {
	front := httptest.NewServer(productProxy(socketPath(t), workerdIdleTimeout))
	defer front.Close()

	if status, body := post(t, front.URL); status != http.StatusServiceUnavailable || body != "Executor is starting" {
		t.Fatalf("POST before workerd listens: %d %q", status, body)
	}
}
