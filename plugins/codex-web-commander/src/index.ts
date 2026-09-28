import { startCommander } from "./server.ts";

const server = startCommander();
const address = server.address();
if (address && typeof address !== "string") console.log(`codex-web-commander listening on http://${address.address}:${address.port}`);
