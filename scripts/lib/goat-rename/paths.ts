export const isTest = (path: string): boolean =>
  /\.(?:test|testkit|fixture|bench)\.[^/]+$|(?:^|\/)(?:__tests__|testkit|testFixtures|fixtures)(?:\/|$)/.test(
    path,
  );
