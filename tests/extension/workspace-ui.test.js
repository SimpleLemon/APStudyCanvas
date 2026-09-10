"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Document, walk } = require("./helpers/dom.js");
const model = require("../../js/content/workspace-model.js"), gpa = require("../../js/content/gpa.js");
const ui = require("../../js/content/workspace-ui.js");
function documentHarness() {
    const doc = new Document(), base = doc.createElement.bind(doc);
    doc.createElement = tag => {
        const node = base(tag), listeners = new Map();
        node.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type,[]); listeners.get(type).push(fn); };
        node.dispatchEvent = event => { for (const fn of listeners.get(event.type) || []) fn({preventDefault(){},...event,target:node}); };
        node.click = () => node.dispatchEvent({type:"click"});
        node.removeAttribute = key => { delete node.attributes[key]; };
        node.querySelectorAll = selector => walk(node).slice(1).filter(n => selector.split(",").some(s => {
            s=s.trim(); if (s === "[data-page]") return !!n.dataset.page;
            if (s === "a[href]") return n.tagName === "a" && n.href;
            return n.tagName === s;
        }));
        node.getClientRects = () => [1]; node.reportValidity = () => true;
        node.showModal = () => { node.open=true; }; node.close = () => { node.open=false; };
        return node;
    };
    doc.createTextNode = text => { const n = base("#text"); n.textContent=text; return n; };
    doc.body=doc.createElement("body"); return doc;
}
async function harness(extra={}) {
    const doc=documentHarness(); let data={}, fail=false, id=0;
    const storage={get:async k=>structuredClone({[k]:data[k]}),set:async v=>{if(fail)throw new Error("Disk full");data={...data,...structuredClone(v)};}};
    const app=ui.createWorkspace({document:doc,window:{location:{origin:"https://canvas.emory.edu"},crypto:{randomUUID:()=>String(++id)},confirm:()=>false,addEventListener(){}},model,gpa,storage,verify:async()=>({origin:"https://canvas.emory.edu",accountId:"42"}),readCourses:async()=>[{id:1,name:"Biology",enrollments:[{type:"student",computed_current_score:90}]}],readPlanner:async()=>[],getBounds:()=>({A:{cutoff:90,gpa:4},F:{cutoff:0,gpa:0}}),openSettings(){},...extra});
    const all=()=>walk(doc.body), text=()=>all().map(n=>n.textContent).join(" ");
    const find=(tag,label)=>all().find(n=>n.tagName===tag&&n.textContent===label);
    const click=label=>{const n=find("button",label);assert.ok(n,`button ${label}`);n.click();};
    const input=(label,value)=>{const wrap=all().find(n=>n.tagName==="label"&&n.children[0]?.textContent===label);assert.ok(wrap,`field ${label}`);const n=wrap.children[1];n.value=value;n.dispatchEvent({type:n.tagName==="select"?"change":"input"});};
    const settle=()=>new Promise(r=>setImmediate(r));
    return {app,doc,all,text,click,input,settle,fail:v=>{fail=v;},saved:()=>Object.values(data)[0]};
}
test("notes save, failure retry, safe Markdown preview, discard guard, trash and restore",async()=>{
    const h=await harness(); h.app.open("notes"); await h.settle();
    h.click("New note");h.input("Title","Lecture 1");h.input("Note · Markdown headings, bold and code supported","# Cells\n**Membrane** <script>alert(1)</script>");
    h.click("Toggle preview");assert.equal(h.all().some(n=>n.tagName==="script"),false);
    assert.ok(h.all().some(n=>n.tagName==="strong"&&n.textContent==="Membrane"));
    h.app.open("study");assert.ok(h.text().includes("Toggle preview"),"unsaved editor survives declined discard");
    h.fail(true);h.click("Save");await h.settle();assert.ok(h.text().includes("Disk full"));
    assert.equal(h.all().find(n=>n.tagName==="textarea").value.includes("Cells"),true);
    h.fail(false);h.click("Save");await h.settle();assert.equal(h.saved().notes[0].title,"Lecture 1");
    h.click("Move to trash");await h.settle();assert.equal(h.saved().notes[0].deleted,true);
    h.input("Show","trash");h.click("Restore");await h.settle();assert.equal(h.saved().notes[0].deleted,false);
    h.app.close();h.app.open("notes");await h.settle();assert.ok(h.text().includes("Lecture 1"));
});
test("study set editing and typed answer practice persist per-card results",async()=>{
    const h=await harness();h.app.open("study");await h.settle();h.click("New study set");h.input("Title","Cells");h.input("Question","Cell boundary?");h.input("Answer","Membrane");h.click("Save");await h.settle();
    h.click("Practice answers");h.input("Your answer"," membrane ");h.click("Check answer");assert.ok(h.text().includes("Correct"));h.click("Save result & next");await h.settle();
    assert.equal(h.saved().study[0].cards[0].correct,1);assert.ok(h.text().includes("Session complete"));
});
test("personal Planner task can be created and completed; late Canvas response preserves editor",async()=>{
    let resolve;const h=await harness({readPlanner:()=>new Promise(r=>{resolve=r;})});h.app.open("planner");await h.settle();h.click("New task");
    resolve([]);await h.settle();assert.ok(h.text().includes("Save"),"untouched editor survives deadline load");
    h.input("Task","Read chapter");h.click("Save");await h.settle();assert.equal(h.saved().planner[0].title,"Read chapter");h.click("Complete");await h.settle();assert.equal(h.saved().planner[0].done,true);
});
test("Grades computes and persists local credits without a Canvas write",async()=>{
    const h=await harness();h.app.open("grades");await h.settle();h.input("Credits","3");assert.ok(h.text().includes("term GPA: 4.00"));h.click("Save");await h.settle();assert.equal(h.saved().grades.courses[1].credits,"3");
});
test("account-read failure offers retry without touching storage",async()=>{
    const h=await harness({verify:async()=>{throw new Error("Offline");}});h.app.open("notes");await h.settle();assert.ok(h.text().includes("Retry"));assert.equal(h.saved(),undefined);
});
