# Memory

Save useful facts and instructions for later conversations, and share them between your devices. Manage memory in **Settings → Memory** on web, desktop, or mobile, choosing the device whose memory you want to manage.

## Memory is on by default

Remembering conversations starts on in every new environment, which acts as its own memory hub. This applies to desktop, WSL, SSH and headless servers, and servers you use through a web browser or mobile. Your choices are kept across restarts.

GOAT summarizes finished conversations using the text generation model by default. On web or desktop, choose a separate **Memory model** in **Settings → Memory** if you prefer. Turn off **Remember conversations** there (or in mobile Memory settings) to stop creating new summaries; saved memories remain. The sharing control is separate: turning sharing off keeps memory on this device.

If the provider keeps refusing a memory model, GOAT pauses generation, shows why under **Settings → Memory**, and retries later; generation resumes right away when the memory model or the provider's version changes.

To share memory, use **Add device** in the hub’s Memory settings. Every device that shares memory can save and edit memories equally. If sharing is off, choose **Make this device the hub** to turn it back on, or add the device from another hub.

## Save and find memories

Choose **Remember something**, enter what you want to keep, and choose its scope: **All projects** for memories shared across conversations, **Project** for one project, or **Thread** for one conversation. Imports use the same scopes.

For project memories, use a shared project binding to share an identity across projects, or return to the repository binding. Changing the binding affects future memories; existing memories keep their scope. Preview an import again after changing its scope or binding.

Search for a memory, open it to read its history, or use **Edit** to change it. Editing keeps it where it was saved.

If search coverage is incomplete or unavailable, an empty result does not prove a memory is missing. Clear the search to browse saved memories instead.

## Import memories

In **Settings → Memory → Import memories**, choose Codex, Claude, or OMO and the destination scope. Discover available profiles on the selected device, preview one, choose the memories, confirm your selection, then apply the import. Up to 32 memories are applied per batch. Other providers are not supported for import.

Servers that support it also offer **Aside**. Discovery lists each Aside store on the device by semantic folder (for example `1/agent` or `1/projects`), and nothing is read until you choose one. Only the `## Current` section of each page is imported, one memory per `###` heading; history, dated logs and the `MEMORY.md`/`USER.md` briefings are skipped. Pages with an unexpected layout, sections over 16 KiB and pages over 256 KiB are listed with the reason and never shortened. A folder with more than 128 importable sections cannot be previewed. Pages from `projects/` import only into a project scope. Import each Aside store on one device and let memory sharing carry it to the others.

**Stop import** stops later batches; a batch already sent may still be applied. After partial completion, a lost response, or a restart, use **Check import result** to check the saved operation. This never applies it again automatically. If asked to preview again, review the latest result before starting another import.

If your browser cannot safely run imports, use a current browser or the desktop app. You can still check a saved import result. Imports leave provider originals unchanged, and forgotten memories are not imported again.

## Share between devices

To share memory, start from the hub. Connect your other device through [Connections](./remote-access.md), then use **Add device** in the hub’s Memory settings. You need settings write permission on both devices and a **Hub address** the other device can reach. Use HTTPS and avoid localhost, which points to the receiving device itself; saving the address does not verify connectivity.

Every member can save and edit memories when it has memory write permission. If you reach the device limit, remove a device before adding another. Use **Remove** to end a device’s shared-memory access, or **Replace key** to replace its sharing credential. Replacing a key requires a connection to that device and settings write permission there.

To stop sharing on a device, turn sharing off in its Memory settings (**Leave sharing** for a member on web or desktop). Saved memories stay on the device. To share them again, make the same device the hub or add the member from the hub’s Memory settings.

If device setup does not finish, use **Retry** to continue the same request. After a reload, use **Replace key** to recover the device or **Remove** to clean up incomplete setup. If settings changed on another device, review the latest settings before trying again.

## Read original conversations

A memory can point back to the conversation it came from. Under **Original conversations** in the Memory settings of the device that owns that conversation, allow the device that needs access. Use **Read original** from the memory’s history to read the source.

Removing that permission applies to later requests and to results still on the hub; it cannot recall content already delivered. Allowing the same device again may wait for its previous removal to complete. If the original is unavailable, check access or reconnect the source environment.

## Review conflicts

When devices make conflicting changes, only the conflicting memory is put on hold. GOAT automatically resolves it using the resolving device’s default provider and model, and applies the result without waiting for approval. If resolution fails, that memory stays on hold.

Open the memory’s history to review the resolution and judgment. The conflicting originals and judgment are kept for 30 days unless the memory is forgotten. Within 30 days of each resolution, choose a retained original and use **Revert resolution** to restore it once. Reverting requires the resolved memory to be unchanged and its original still available; a revert cannot itself be reverted. Deletion takes priority over edits, so an older edit cannot bring back a forgotten memory.

Settings shows the latest revert attempt for each resolution. A refused attempt shows its reason and does not use up the one-time revert; you can explicitly try again if it is still eligible. History is live: return to its first page to see new changes.

## Retry report delivery

In **Settings → Memory**, open the memory’s history and select up to 32 failed reports that have exhausted automatic delivery retries. **Retry selected reports** lets delivery try again; it does not increase your storage quota or free storage. Reports handled by another device are not eligible here.

## Forget a memory

Open the memory, choose **Forget**, and confirm. This cannot be undone. Forgetting removes the GOAT memory’s content, retained resolution originals and judgment, and derived content such as summaries made from it. Other devices remove it when they sync.

The provider’s original conversation stays, but forgotten content is never imported again. Forgetting content does not automatically shrink the database file.

## Agent access

Agent memory access depends on the environment’s current policy and the run’s permissions. For scheduled tasks, subagents, and work GOAT Bot or Slack starts for you, **Saved limit** is the stored maximum: none, read only, or read and write. **Allowed now** is what the server currently permits, which may be narrower. If **Allowed now** is absent, the server does not know the current value. Turning agent memory access on cannot widen the saved limit.

When connecting an outside agent through OAuth, select **Read memory** or **Write memory** under **Memory access (optional)** if needed. Nothing is selected by default, and memory permissions are separate from thread access.

## When a conversation cannot save memories

Forked or imported conversations, and conversations that have received more memories than GOAT can safely track, can still use memories but cannot save new ones or produce new memory summaries. Start a new conversation to save the memory.

## Connection problems

If an agent says its memory search was incomplete or unavailable, do not assume the memory is missing.

In **Settings → Memory → Hub diagnostics**, sharing off means memory sharing is disabled; unbound means you need to connect a memory space. Staging means initial memories are still arriving. Ready means initial setup is complete, but does not guarantee that the hub is connected or every memory is searchable.

For a recoverable sync hold, restore compatibility or connectivity, then use **Reconcile** when available to let eligible work resume. A permanent hold needs attention to device identity or authorization in Sharing settings; Reconcile cannot bypass it. **Reconcile accepted** confirms the request was accepted, not that synchronization has finished. **Last valid settings in use** means the latest settings could not be published; review the settings and reload diagnostics after correcting the problem.

On web and desktop, if Memory says **Device disconnected**, reconnect that environment to continue. If it says **Memory unavailable**, update or reconnect the selected environment. **Hub disconnected** means the hub connection is offline; **Hub connected** alone does not mean every memory is ready to read. **Waiting to sync** means that memory still has changes to share.
