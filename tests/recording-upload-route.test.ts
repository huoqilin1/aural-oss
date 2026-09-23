import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

// Execute the real route, with in-memory storage/database rather than live I/O.
function harness() {
  const source = ts.createSourceFile("route.ts", readFileSync(new URL("../src/app/api/session/upload/route.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((n)=>ts.isFunctionDeclaration(n) && n.name?.text === "POST")!;
  const files = new Map<string, Buffer>();
  const rows: Record<string, unknown> = {};
  let failLink = false;
  let failUpload = false;
  let sessionExists = true;
  const writes: string[] = [];
  const supabaseAdmin = {
    storage:{from:()=>({
      upload:async (key:string,bytes:Buffer)=>{
        if(failUpload || files.has(key)) return {error:{message:"upload conflict"}};
        files.set(key,bytes);writes.push("upload"); return {error:null};
      },
      download:async (key:string)=>({data:files.has(key)?new Blob([new Uint8Array(files.get(key)!)]):null}),
      createSignedUrl:async (key:string)=>({data:{signedUrl:`https://example.test/${key}`},error:null}),
    })},
    from:()=>{
      let update: Record<string,unknown> | undefined;
      const query = {
        select:()=>query, eq:()=>query,
        update:(data:Record<string,unknown>)=>{update=data;return query;},
        maybeSingle:async()=>{
          if(update && failLink) return {data:null,error:{message:"database offline"}};
          if(!sessionExists) return {data:null,error:null};
          if(update){Object.assign(rows,update);writes.push("link");}
          return {data:{id:"local-session"},error:null};
        },
      };
      return query;
    },
  };
  const code=ts.transpileModule(node.getText(source).replace(/^export\s+/,""),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const sandbox=vm.createContext({Buffer,createHash,supabaseAdmin,NextResponse:Response,
    log:{error:()=>{}},Request,Response,FormData,Blob});
  vm.runInContext(code,sandbox);
  async function upload() {
    const form = new FormData();
    form.append("file",new Blob(["local simulated audio"],{type:"audio/webm"}),"recording.webm");
    form.append("sessionId","local-session");form.append("type","recording");form.append("audioDuration","12");
    sandbox.req=new Request("http://localhost/api/session/upload",{method:"POST",body:form});
    return await vm.runInContext("POST(req)",sandbox) as Response;
  }
  return {upload,rows,files,writes,setFailLink:(value:boolean)=>{failLink=value;},
    setFailUpload:(value:boolean)=>{failUpload=value;},setExists:(value:boolean)=>{sessionExists=value;}};
}

test("upload only reports success after recording URL and duration are durably linked",async()=>{
  const h=harness();
  const response=await h.upload();
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(h.rows.audioRecordingUrl,data.url);
  assert.equal(h.rows.audioDuration,12);
  assert.deepEqual(h.writes,["upload","link"]);
});

test("lost response or failed linkage can reuse verified identical audio, without overwrite",async()=>{
  const h=harness();h.setFailLink(true);
  assert.equal((await h.upload()).status,500);
  assert.equal(h.rows.audioRecordingUrl,undefined);
  h.setFailLink(false);
  assert.equal((await h.upload()).status,200);
  assert.equal((await h.upload()).status,200);
  assert.equal(h.files.size,1);
  assert.equal(h.writes.filter((w)=>w==="upload").length,1);
});

test("storage failure or missing session cannot be presented as a saved recording",async()=>{
  const h=harness();h.setFailUpload(true);
  assert.equal((await h.upload()).status,500);
  assert.equal(h.rows.audioRecordingUrl,undefined);
  h.setExists(false);h.setFailUpload(false);
  assert.equal((await h.upload()).status,404);
  assert.equal(h.files.size,0);
});

test("a conflicting object is not silently accepted as the candidate recording",async()=>{
  const h=harness();h.setFailLink(true);
  await h.upload();
  const key=Array.from(h.files.keys())[0];h.files.set(key,Buffer.from("unrelated bytes"));
  h.setFailLink(false);
  assert.equal((await h.upload()).status,500);
  assert.equal(h.rows.audioRecordingUrl,undefined);
});
