// ?v1fixture: checks the v1 CSS scoping and portal root (e2e/v1fixture.spec.ts). A v1 Button, text-work-log text, an
// open Popover and an open Tooltip inside the boundary; identical plain elements outside it keep browser defaults.
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { V1Boundary } from "../V1Boundary.tsx";

export function V1Fixture() {
  return (
    <div style={{ padding: 24, display: "grid", gap: 24, height: "100%", overflow: "auto", boxSizing: "border-box" }}>
      <V1Boundary data-testid="inside" style={{ padding: 16 }}>
        <Button data-testid="v1-button">Run</Button>
        <p data-testid="v1-text" className="text-work-log">Ran 3 commands</p>
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger render={<button type="button" data-testid="v1-tooltip-trigger">hover</button>} />
            <TooltipPopup data-testid="v1-tooltip">Tooltip text</TooltipPopup>
          </Tooltip>
        </TooltipProvider>
        <div style={{ height: 80 }} />
        <Popover open>
          <PopoverTrigger render={<button type="button" data-testid="v1-popover-trigger">open</button>} />
          <PopoverPopup data-testid="v1-popover">Popover text</PopoverPopup>
        </Popover>
      </V1Boundary>
      <div data-testid="outside">
        <button data-testid="plain-button">Run</button>
        <p data-testid="plain-text" className="text-work-log">Ran 3 commands</p>
        <h1 data-testid="plain-h1">Heading</h1>
      </div>
    </div>
  );
}
