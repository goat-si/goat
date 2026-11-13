/** A title the server cut is shown cut, with an ellipsis. */
export const lookedUpTitle = (title: string, truncated: boolean | undefined) =>
  truncated === true ? `${title}…` : title;
