import fs from "fs";
import { createCodexAuth } from "./src/services/provider-auth/integrations/codex";
async function main() {
  const authJson = fs.readFileSync("/tmp/codex_test_auth.json", "utf8");
  const cred = await createCodexAuth().import!({ kind: "auth_json", value: authJson });
  const tok = cred.secrets.accessToken;
  const hid = cred.account.accountId!;
  const base = { "authorization": `Bearer ${tok}`, "chatgpt-account-id": hid, "accept": "application/json" };
  // models (read) - does it return 200?
  const m = await fetch("https://chatgpt.com/backend-api/codex/models?client_version=0.149.0", { headers: base });
  console.log("codex/models ->", m.status);
  // accounts/check
  const c = await fetch("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", { headers: base });
  console.log("accounts/check ->", c.status, (await c.text()).slice(0, 200));
}
main();
