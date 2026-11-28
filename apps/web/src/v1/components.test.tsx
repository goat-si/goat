// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHeader } from "./ChatHeader.tsx";
import { ActivitySidebar } from "./ActivitySidebar.tsx";
import { WorkGroup } from "./WorkGroup.tsx";
import { UserMessageBubble, AssistantMessage } from "./Messages.tsx";
import { QueuedBanner } from "./QueuedBanner.tsx";
import { ThreadComposer } from "./ThreadComposer.tsx";
import { SidebarThreadRow } from "./SidebarThreadRow.tsx";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement; let root: Root;
beforeEach(()=>{container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.useRealTimers();});
const render=(node: React.ReactNode)=>act(()=>root.render(node));
const click=(label: string)=>act(()=>{const el=container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(el).not.toBeNull(); el!.click();});
describe("v1 components",()=>{
 it("renders the breadcrumb and Activity sections",()=>{render(<><ChatHeader title="Thread" project="goat"/><ActivitySidebar priorityCount={2} priority={<span>Priority item</span>} threads={<span>Thread item</span>} working={<span>Working item</span>} updating="Updating · 3 of 5 machines"/></>);for(const text of ["Thread", "goat", "Priority (2)", "Threads", "Working", "Updating · 3 of 5 machines"]) expect(container.textContent).toContain(text);});
 it("renders message text and thread row",()=>{const onClick=vi.fn();render(<><UserMessageBubble text="Hello"/><AssistantMessage text="Answer" streaming/><SidebarThreadRow title="Thread" project="goat" meta="Today" providerIcon="C" status="unread" selected={false} onClick={onClick}/></>);expect(container.textContent).toContain("Hello");expect(container.textContent).toContain("Answer");expect(container.textContent).toContain("Thread");act(()=>container.querySelector("button")!.click());expect(onClick).toHaveBeenCalledOnce();});
 it("renders worked and live working timer",()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-01-01T00:00:22Z"));render(<><WorkGroup status="worked" duration="4m 12s" steps={[]}/><WorkGroup status="working" duration={null} startedAt="2026-01-01T00:00:00Z" steps={[]}/></>);expect(container.textContent).toContain("Worked for 4m 12s");expect(container.textContent).toContain("Working for 22s");act(()=>vi.advanceTimersByTime(1000));expect(container.textContent).toContain("Working for 23s");});
 it("fires queue callbacks and reorders by keyboard",()=>{const onEdit=vi.fn(),onCancelEdit=vi.fn(),onSendNow=vi.fn(),onDelete=vi.fn(),onReorder=vi.fn();const items=[{inputId:"a",text:"first",editable:true},{inputId:"b",text:"second",editable:true}];const props={items,editingId:null,onEdit,onCancelEdit,onSendNow,onDelete,onReorder};render(<QueuedBanner {...props}/>);expect(container.textContent).toContain("Queued");click("Edit queued message");expect(onEdit).toHaveBeenCalledWith("a");act(()=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent==="Send now")!.click());expect(onSendNow).toHaveBeenCalledWith("a");click("Remove queued message");expect(onDelete).toHaveBeenCalledWith("a");act(()=>container.querySelector('[aria-label^="Reorder"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})));expect(onReorder).toHaveBeenCalledWith(["b","a"]);render(<QueuedBanner {...props} editingId="a"/>);click("Cancel editing queued message");expect(onCancelEdit).toHaveBeenCalledOnce();});
 it("renders composer controls and invokes submit and stop",()=>{const onSubmit=vi.fn(),onStop=vi.fn();const p={value:"test",onChange:vi.fn(),onSubmit,onStop,running:false,placeholder:"Ask",accessLabel:"Full access",modelLabel:"4 Neon",effortLabel:"High",providerIcon:<span>icon</span>,plusProps:{disabled:true},micProps:{disabled:true}};render(<ThreadComposer {...p}/>);expect(container.textContent).toContain("Full access");expect(container.textContent).toContain("4 Neon");click("Send");expect(onSubmit).toHaveBeenCalledOnce();render(<ThreadComposer {...p} running/>);click("Stop");expect(onStop).toHaveBeenCalledOnce();});
});
