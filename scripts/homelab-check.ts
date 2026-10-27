import { readServiceInfo } from "../src/dev/read-service-info";
const connection = await (await fetch("http://127.0.0.1:8080/cvm.json")).json() as Record<string, unknown>;
if (Object.keys(connection).sort().join(",") !== "relayUrl,servicePubkey") throw new Error("PUBLIC_CONNECTION_FIELDS_INVALID");
const info = await readServiceInfo("http://127.0.0.1:8080");
console.log(JSON.stringify({ check: "signed-contextvm-over-public-wss", status: "passed", provider: info.providerLabel, servicePubkey: connection.servicePubkey, relayUrl: connection.relayUrl }));
