const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const IS_SIGNING_IN_INDEX = 0;
const ERROR_INDEX = 1;

function createHarness({ authState = { isLoaded: true, isSignedIn: false, user: null }, values = {} } = {}) {
  return {
    cursor: 0,
    values,
    authState,
    signInResult: { success: true },
    signInCalls: 0,
  };
}

function collectStrings(node, out = []) {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectStrings(child, out));
    return out;
  }
  if (node && typeof node === "object") collectStrings(node.props?.children, out);
  return out;
}

// Finds the nearest node with an onClick handler whose rendered subtree
// contains the given text (translation keys render as their literal key
// under the mocked t()).
function findButtonByText(node, text) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButtonByText(child, text);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (typeof node.props?.onClick === "function" && collectStrings(node).includes(text)) {
    return node;
  }
  return findButtonByText(node.props?.children, text);
}

function hasText(node, text) {
  return collectStrings(node).includes(text);
}

async function settleAsyncHandler() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadAuthenticationStep(t) {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-authentication-step-",
    noExternal: ["react", "react-i18next", "lucide-react"],
    mockModules: {
      react: `
        export default {};
        export function useState(initialValue) {
          const harness = globalThis.__authenticationStepHarness;
          const index = harness.cursor++;
          if (!(index in harness.values)) {
            harness.values[index] = typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [harness.values[index], (nextValue) => {
            harness.values[index] = typeof nextValue === "function"
              ? nextValue(harness.values[index])
              : nextValue;
          }];
        }
        export function useCallback(callback) { return callback; }
        export function useEffect() {}
      `,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "/hooks/useAuth": `
        export function useAuth() {
          return globalThis.__authenticationStepHarness.authState;
        }
      `,
      "/lib/auth": `
        export let AUTH_URL = globalThis.__authenticationStepHarness.authUrl ?? "configured";
        export async function signIn() {
          const harness = globalThis.__authenticationStepHarness;
          harness.signInCalls += 1;
          return harness.signInResult;
        }
      `,
      "/OnboardingShell": `
        export function CompactOnboardingFrame(props) { return props.children; }
      `,
      "/ui/button": `export function Button() { return null; }`,
      "lucide-react": `
        const Icon = () => null;
        export { Icon as AlertCircle, Icon as ArrowRight, Icon as Building2, Icon as Check, Icon as Loader2 };
      `,
    },
  });
  const { default: AuthenticationStep } = await vite.ssrLoadModule("/components/AuthenticationStep.tsx");
  return AuthenticationStep;
}

test("not-configured state blocks access with no way to continue", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  t.after(() => {
    delete globalThis.__authenticationStepHarness;
  });

  const harness = createHarness({ authState: { isLoaded: true, isSignedIn: false, user: null } });
  harness.authUrl = "";
  globalThis.__authenticationStepHarness = harness;
  const AuthenticationStep = await loadAuthenticationStep(t);

  const render = () => {
    harness.cursor = 0;
    return AuthenticationStep({ onAuthComplete() {} });
  };

  const tree = render();
  assert.ok(hasText(tree, "auth.cloudNotConfigured"));
  assert.ok(!hasText(tree, "auth.getStarted"), "no bypass button should render");
  assert.ok(
    !findButtonByText(tree, "auth.getStarted"),
    "there must be no way to proceed without SSO configured"
  );
});

test("signed-out state never offers a way to skip sign-in", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  t.after(() => {
    delete globalThis.__authenticationStepHarness;
  });
  const harness = createHarness();
  globalThis.__authenticationStepHarness = harness;
  const AuthenticationStep = await loadAuthenticationStep(t);

  const render = () => {
    harness.cursor = 0;
    return AuthenticationStep({ onAuthComplete() {} });
  };

  const tree = render();
  assert.ok(findButtonByText(tree, "auth.sso.continueWithSSO"), "sign-in button should render");
  assert.ok(
    !hasText(tree, "auth.emailStep.continueWithoutAccount"),
    "no guest/skip-account escape should render"
  );
});

test("sign-in failure surfaces the error and re-enables the button", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  t.after(() => {
    delete globalThis.__authenticationStepHarness;
  });
  const harness = createHarness();
  harness.signInResult = { success: false, error: "Access denied for this organization." };
  globalThis.__authenticationStepHarness = harness;
  const AuthenticationStep = await loadAuthenticationStep(t);

  const render = () => {
    harness.cursor = 0;
    return AuthenticationStep({ onAuthComplete() {} });
  };

  const button = findButtonByText(render(), "auth.sso.continueWithSSO");
  assert.ok(button, "sign-in button should render");
  await button.props.onClick();
  await settleAsyncHandler();

  assert.equal(harness.signInCalls, 1);
  assert.equal(harness.values[IS_SIGNING_IN_INDEX], false);
  assert.equal(harness.values[ERROR_INDEX], "Access denied for this organization.");
});

test("sign-in success keeps the pending state until the session updates", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  t.after(() => {
    delete globalThis.__authenticationStepHarness;
  });
  const harness = createHarness();
  harness.signInResult = { success: true, user: { sub: "abc", email: "a@example.com", name: "A" } };
  globalThis.__authenticationStepHarness = harness;
  const AuthenticationStep = await loadAuthenticationStep(t);

  const render = () => {
    harness.cursor = 0;
    return AuthenticationStep({ onAuthComplete() {} });
  };

  const button = findButtonByText(render(), "auth.sso.continueWithSSO");
  await button.props.onClick();
  await settleAsyncHandler();

  assert.equal(harness.signInCalls, 1);
  // onAuthComplete fires from the isSignedIn effect once useAuth reports the
  // new session (exercised via useEffect, a no-op under this harness) — until
  // then the button stays in its pending state rather than flashing "idle".
  assert.equal(harness.values[IS_SIGNING_IN_INDEX], true);
  assert.equal(harness.values[ERROR_INDEX] ?? null, null);
});

test("already-signed-in state greets the user and completes on continue", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  t.after(() => {
    delete globalThis.__authenticationStepHarness;
  });
  const harness = createHarness({
    authState: { isLoaded: true, isSignedIn: true, user: { sub: "abc", email: "a@example.com", name: "Ada" } },
  });
  globalThis.__authenticationStepHarness = harness;
  const AuthenticationStep = await loadAuthenticationStep(t);
  let completed = 0;

  const render = () => {
    harness.cursor = 0;
    return AuthenticationStep({ onAuthComplete: () => (completed += 1) });
  };

  const tree = render();
  assert.ok(hasText(tree, "auth.signedIn.welcomeBackName"));
  const button = findButtonByText(tree, "auth.common.continue");
  assert.ok(button, "continue button should render");
  button.props.onClick();
  assert.equal(completed, 1);
});
