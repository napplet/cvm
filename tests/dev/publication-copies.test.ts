import { expect, test } from "bun:test";
import { verifiedPublicationServers } from "../../src/dev-ui/publication-copies";

const files = [{ path: "index.html" }, { path: "icon.svg" }];
const servers = ["https://one.example", "https://two.example", "https://three.example"];
const copy = (server: string, file: string, state = "verified") => ({ server, file, state });
test("two complete copies qualify despite an additional destination failure", () => {
  const receipts = servers.flatMap((server, index) => files.map(file => copy(server, file.path, index === 2 ? "failed" : "verified")));
  expect(verifiedPublicationServers(files, servers, receipts)).toEqual(servers.slice(0, 2));
});
test("split files, duplicates and unselected destinations cannot inflate coverage", () => {
  const receipts = [copy(servers[0]!, "index.html"), copy(servers[1]!, "icon.svg"), ...files.map(file => copy("https://unselected.example", file.path))];
  expect(verifiedPublicationServers(files, servers, [...receipts, ...receipts])).toEqual([]);
  expect(verifiedPublicationServers(files, servers, [...receipts, copy(servers[0]!, "icon.svg")])).toEqual([servers[0]!]);
});
test("latest failure wins and alternate URL spellings remain one destination", () => {
  const receipts = files.map(file => copy(servers[0]!, file.path));
  expect(verifiedPublicationServers(files, [servers[0]!, "https://ONE.example:443/"], receipts)).toEqual([servers[0]!]);
  expect(verifiedPublicationServers(files, servers, [...receipts, copy(servers[0]!, "index.html", "failed")])).toEqual([]);
  expect(verifiedPublicationServers([], servers, receipts)).toEqual([]);
});
