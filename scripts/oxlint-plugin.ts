/**
 * Repository lint rules. `.oxlintrc.jsonc` chooses the files each rule covers.
 * Adapted from the rat-stack Oxlint plugins.
 */
import { definePlugin, defineRule, type ESTree } from "@oxlint/plugins";

/** True when a `var` binding is hoisted to module scope rather than into a function. */
const hoistedToModule = (node: ESTree.Node) => {
  for (let current = node.parent; current !== null; current = current.parent) {
    switch (current.type) {
      case "Program":
        return true;
      case "ArrowFunctionExpression":
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "StaticBlock":
      case "TSModuleBlock":
        return false;
    }
  }
  return false;
};

/** `let` is module state only when declared directly in the module body. */
const declaredInModuleBody = (node: ESTree.VariableDeclaration) =>
  node.parent.type === "Program" ||
  (node.parent.type === "ExportNamedDeclaration" && node.parent.parent.type === "Program");

const noModuleLevelMutableState = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep mutable state out of module-level let and var bindings." },
    messages: {
      moduleState:
        "Module-level let and var are shared by every request a Worker isolate or server process handles. Keep state in a Ref or service owned by a Layer, or in storage.",
    },
  },
  create: (context) => ({
    VariableDeclaration(node) {
      if (node.declare || (node.kind !== "let" && node.kind !== "var")) return;
      if (node.kind === "let" ? declaredInModuleBody(node) : hoistedToModule(node))
        context.report({ node, messageId: "moduleState" });
    },
  }),
});

const runners = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

/** `Effect.runPromise(...)` and friends, or `ManagedRuntime.make(...)`. */
const manualRunner = (callee: ESTree.Node) => {
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier"
  )
    return undefined;
  const call = `${callee.object.name}.${callee.property.name}`;
  if (callee.object.name === "Effect" && runners.has(callee.property.name)) return call;
  if (call === "ManagedRuntime.make") return call;
  return undefined;
};

const noManualEffectRuntimeInTests = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Run scenario Effects through @effect/vitest instead of starting a runtime by hand.",
    },
    messages: {
      manualRunner:
        "{{call}} runs an Effect outside the scenario's runtime. Use @effect/vitest `layer` and `it.effect`, and inject capabilities as services. Bridges to Promise callbacks need a disable comment saying which API requires one.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      const call = manualRunner(node.callee);
      if (call !== undefined)
        context.report({ node: node.callee, messageId: "manualRunner", data: { call } });
    },
  }),
});

export default definePlugin({
  meta: { name: "executor" },
  rules: {
    "no-module-level-mutable-state": noModuleLevelMutableState,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
  },
});
