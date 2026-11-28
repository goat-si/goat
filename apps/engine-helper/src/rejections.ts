// Unhandled promise rejections an SDK is known to leave behind harmlessly. Anything else ends the
// helper (and only this thread's engine). Engines register classifiers when they load.
type Classifier = (reason: unknown) => string | undefined;

const classifiers: Classifier[] = [];

export function containRejections(classifier: Classifier): () => void {
  classifiers.push(classifier);
  return () => {
    const index = classifiers.indexOf(classifier);
    if (index >= 0) classifiers.splice(index, 1);
  };
}

export function classifyRejection(reason: unknown): string | undefined {
  for (const classifier of classifiers) {
    const benign = classifier(reason);
    if (benign !== undefined) return benign;
  }
  return undefined;
}
