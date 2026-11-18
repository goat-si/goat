import type { AddProjectCloneFlow } from "./CommandPalette.logic";
import { NewProjectSummary, RemoteRepositorySummary } from "./CommandPaletteAddProject";

export function CommandPaletteProjectSummaries(props: {
  pathPreview: string | null;
  name: string;
  projectsRoot: string | null;
  environmentLabel: string | null;
  cloneFlow: AddProjectCloneFlow | null;
}) {
  const flow = props.cloneFlow;
  return (
    <>
      {props.pathPreview !== null ? (
        <NewProjectSummary
          name={props.name}
          pathPreview={props.pathPreview}
          projectsRoot={props.projectsRoot}
          environmentLabel={props.environmentLabel}
        />
      ) : null}
      {flow?.step === "confirm" ? (
        <RemoteRepositorySummary
          source={flow.source}
          title={flow.repository?.nameWithOwner ?? flow.repositoryInput}
          description={flow.repository?.url ?? flow.remoteUrl}
        />
      ) : null}
    </>
  );
}
