import test from "node:test";
import assert from "node:assert/strict";
import { parseCustomProviders } from "../providers/custom";
import { findProviderByHost, getProvider, listCustomAdapters, listProviders, setCustomProviders } from "../providers/registry";

const RESERVED_IDS = new Set(["chatgpt", "claude"]);
const RESERVED_HOSTS = new Set(["chatgpt.com", "claude.ai"]);

test("parseCustomProviders turns label + url into a provider and a browser adapter", () => {
  const result = parseCustomProviders(
    [{ label: "Z.ai", url: "https://chat.z.ai/" }],
    RESERVED_IDS,
    RESERVED_HOSTS
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.providers.length, 1);
  const [provider] = result.providers;
  assert.equal(provider.id, "chat-z-ai");
  assert.equal(provider.label, "Z.ai");
  assert.equal(provider.host, "chat.z.ai");
  assert.equal(provider.chatUrl, "https://chat.z.ai/");
  assert.equal(provider.custom, true);
  assert.equal(provider.maxMessageChars, 12000);

  assert.deepEqual(result.adapters[0], {
    id: "chat-z-ai",
    label: "Z.ai",
    chatUrl: "https://chat.z.ai/",
    host: "chat.z.ai",
    matchPattern: "https://chat.z.ai/*",
    inputSelectors: [],
    submitSelectors: [],
    assistantSelectors: []
  });
});

test("parseCustomProviders keeps optional selectors, id and limits", () => {
  const result = parseCustomProviders(
    [{
      id: "My Bot",
      label: "My Bot",
      url: "https://bot.example.com/chat",
      inputSelector: "textarea#q",
      submitSelector: " button.send ",
      responseSelector: ".reply",
      maxMessageChars: 50000
    }],
    RESERVED_IDS,
    RESERVED_HOSTS
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.providers[0].id, "my-bot");
  assert.equal(result.providers[0].maxMessageChars, 50000);
  assert.deepEqual(result.adapters[0].inputSelectors, ["textarea#q"]);
  assert.deepEqual(result.adapters[0].submitSelectors, ["button.send"]);
  assert.deepEqual(result.adapters[0].assistantSelectors, [".reply"]);
});

test("parseCustomProviders rejects unsafe or conflicting entries without dropping valid ones", () => {
  const result = parseCustomProviders(
    [
      { label: "Plain http", url: "http://bot.example.com/" },
      { label: "Not a url", url: "chat.example.com" },
      { label: "Creds", url: "https://user:pass@bot.example.com/" },
      { label: "Built-in clash", url: "https://chatgpt.com/" },
      { url: "https://nolabel.example.com/" },
      { label: "Good", url: "https://good.example.com/" },
      { label: "Duplicate", url: "https://good.example.com/other" },
      { label: "Local dev", url: "http://localhost:3000/" }
    ],
    RESERVED_IDS,
    RESERVED_HOSTS
  );

  assert.deepEqual(result.providers.map((provider) => provider.label), ["Good", "Local dev"]);
  assert.equal(result.errors.length, 6);
  assert.match(result.errors.join("\n"), /already a built-in/);
  assert.match(result.errors.join("\n"), /listed twice/);
});

test("parseCustomProviders tolerates a missing or malformed setting", () => {
  assert.deepEqual(parseCustomProviders(undefined, RESERVED_IDS, RESERVED_HOSTS).providers, []);
  assert.equal(parseCustomProviders({ label: "x" }, RESERVED_IDS, RESERVED_HOSTS).errors.length, 1);
});

test("registry merges custom providers with the built-ins", (t) => {
  t.after(() => setCustomProviders([]));
  const builtIns = listProviders().length;

  const errors = setCustomProviders([{ label: "Z.ai", url: "https://chat.z.ai/" }]);
  assert.deepEqual(errors, []);
  assert.equal(listProviders().length, builtIns + 1);
  assert.equal(getProvider("chat-z-ai")?.label, "Z.ai");
  assert.equal(findProviderByHost("chat.z.ai")?.id, "chat-z-ai");
  assert.equal(findProviderByHost("chatgpt.com")?.id, "chatgpt");
  assert.equal(listCustomAdapters().length, 1);

  // A custom site can't shadow a built-in id or host.
  assert.equal(setCustomProviders([{ id: "chatgpt", label: "Fake", url: "https://fake.example/" }]).length, 1);
  assert.equal(getProvider("chatgpt")?.host, "chatgpt.com");
});
