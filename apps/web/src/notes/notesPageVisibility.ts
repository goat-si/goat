// Shortcut handlers across the app resolve mod+n; they all read this so the Notes page owns it
// while mounted, under browser and hash history alike.
let notesPageMounts = 0;

export function isNotesPageOpen(): boolean {
  return notesPageMounts > 0;
}

export function markNotesPageOpen(): () => void {
  notesPageMounts += 1;
  return () => {
    notesPageMounts -= 1;
  };
}
