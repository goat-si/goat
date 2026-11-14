import { expect, it } from "@effect/vitest";
import * as BootService from "./bootService.ts";

const linuxPlan = {
  program: ["/home/sam/.t3/runtime/goat/versions/1.2.3/goat", "__service-launcher"],
  baseDir: "/home/sam/.t3",
  logPath: "/home/sam/.t3/userdata/logs/boot-service.log",
  unitPath: "/home/sam/.config/systemd/user/goat.service",
};

it("reads the served T3 home back out of a rendered unit or plist", () => {
  const plan = (baseDir: string) => ({
    program: [`${baseDir}/runtime/goat/versions/1.2.3/goat`, "__service-launcher"],
    baseDir,
    logPath: `${baseDir}/userdata/logs/boot-service.log`,
    unitPath: "/home/sam/.config/systemd/user/goat.service",
  });

  expect(
    BootService.bootServiceBaseDirOf(BootService.renderBootServiceUnit(plan("/home/sam/.t3"))),
  ).toBe("/home/sam/.t3");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceUnit(plan("/home/sam/T3 Data/100%")),
    ),
  ).toBe("/home/sam/T3 Data/100%");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServicePlist(plan("/Users/sam/a&b"), {
        homeDir: "/Users/sam",
        environmentPath: "/usr/bin",
      }),
    ),
  ).toBe("/Users/sam/a&b");
  expect(BootService.bootServiceBaseDirOf("[Service]\nExecStart=/x\n")).toBeUndefined();
});

it("reads the home of units installed before the GOAT rename", () => {
  // goat-rename: legacy-begin
  expect(
    BootService.bootServiceBaseDirOf("[Service]\nEnvironment=T3CODE_HOME=/home/sam/.t3\n"),
  ).toBe("/home/sam/.t3");
  expect(
    BootService.bootServiceBaseDirOf(
      "<dict>\n    <key>T3CODE_HOME</key>\n    <string>/Users/sam/.t3</string>\n</dict>",
    ),
  ).toBe("/Users/sam/.t3");
  // goat-rename: legacy-end
  const unit = BootService.renderBootServiceUnit(linuxPlan);
  expect(BootService.bootServiceBaseDirOf(unit)).toBe(linuxPlan.baseDir);
  expect(unit).toContain(`Environment=GOAT_HOME=${linuxPlan.baseDir}`);
  expect(unit).toContain(`Environment=T3CODE_HOME=${linuxPlan.baseDir}`); // goat-rename: legacy
});
