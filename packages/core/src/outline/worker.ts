// Worker entry: tree-sitter parsing runs here, off the daemon's main thread, so a large file
// or a first scan of a big repo never delays a hook reply. Messages that arrive while the
// grammars load are queued, not dropped.
import { initOutlines, outline } from "./index.ts";

declare const self: Worker;
interface Req {
  id: number;
  path: string;
  text: string;
}
const inbox: Req[] = [];
let ready = false;
const handle = (r: Req) => {
  let symbols = null;
  try {
    symbols = outline(r.path, r.text);
  } catch {}
  self.postMessage({ id: r.id, symbols });
};
self.onmessage = (e: MessageEvent<Req | "ping">) => {
  if (e.data === "ping") return void (ready && self.postMessage("ready"));
  if (ready) handle(e.data);
  else inbox.push(e.data);
};
initOutlines()
  .then(() => {
    ready = true;
    self.postMessage("ready");
    for (const r of inbox.splice(0)) handle(r);
  })
  .catch((err) => self.postMessage({ error: String(err) }));
