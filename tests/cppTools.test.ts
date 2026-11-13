import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = {
  updates: [] as { key: string; value: unknown; target: unknown }[],
  apiRequests: 0,
  registered: [] as { canProvideConfiguration(uri: { fsPath: string }): Promise<boolean> }[],
  messages: [] as string[],
};
const config = {
  features: true,
  extras: [] as string[],
  provider: "",
  workspaceProvider: undefined as string | undefined,
  folders: [{ uri: { fsPath: "/work" } }] as unknown[] | undefined,
  modalAnswer: undefined as string | undefined,
};

vi.mock("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  Uri: { file: (path: string) => ({ fsPath: path }) },
  workspace: {
    get workspaceFolders() {
      return config.folders;
    },
    workspaceFile: undefined,
    getWorkspaceFolder: (): undefined => undefined,
    getConfiguration: (section: string) => ({
      get: (key: string, fallback: unknown) => {
        if (section === "indigoDriver") {
          return key === "cLanguageFeatures" ? config.features : key === "includePaths" ? config.extras : fallback;
        }
        return key === "default.configurationProvider" ? config.provider : fallback;
      },
      inspect: () => ({ workspaceValue: config.workspaceProvider }),
      update: async (key: string, value: unknown, target: unknown) => {
        calls.updates.push({ key, value, target });
        config.provider = (value as string | undefined) ?? "";
        config.workspaceProvider = value as string | undefined;
      },
    }),
  },
  window: {
    showInformationMessage: async (message: string) => {
      calls.messages.push(message);
    },
    showWarningMessage: async (message: string) => {
      calls.messages.push(message);
      return config.modalAnswer;
    },
  },
}));
vi.mock("vscode-cpptools", () => ({
  Version: { v5: 5 },
  getCppToolsApi: async () => {
    calls.apiRequests++;
    return {
      registerCustomConfigurationProvider: (provider: never) => calls.registered.push(provider),
      notifyReady: (): undefined => undefined,
      didChangeCustomConfiguration: (): undefined => undefined,
      dispose: (): undefined => undefined,
    };
  },
}));

const { buildIncludePath, CppToolsIntegration } = await import("../src/cppTools");

const ID = "societa-astronomica-schiaparelli.indigo-driver";
const lines: string[] = [];
const integration = () =>
  new CppToolsIntegration(
    { extension: { id: ID } } as never,
    { originOf: (path: string) => (path === "/cache/shadow.c" ? "/work/driver" : undefined) } as never,
    { appendLine: (line: string) => lines.push(line) } as never,
  );

beforeEach(() => {
  calls.updates = [];
  calls.apiRequests = 0;
  calls.registered = [];
  calls.messages = [];
  Object.assign(config, {
    features: true,
    extras: [],
    provider: "",
    workspaceProvider: undefined,
    folders: [{ uri: { fsPath: "/work" } }],
    modalAnswer: undefined,
  });
  lines.length = 0;
});

describe("buildIncludePath", () => {
  it("lists the driver folder, the extras and the system directories without duplicates", () => {
    const paths = buildIncludePath("/work/driver", ["/opt/indigo/include", "/usr/include"], undefined);
    expect(paths[0]).toBe("/work/driver");
    expect(paths).toContain("/opt/indigo/include");
    expect(paths.filter((p) => p === "/usr/include")).toHaveLength(1);
  });

  it("expands the workspace folder and the home directory", () => {
    const paths = buildIncludePath("/work/driver", ["${workspaceFolder}/include", "~/indigo"], "/work");
    expect(paths).toContain("/work/include");
    expect(paths.some((p) => p.endsWith("/indigo") && !p.startsWith("~"))).toBe(true);
  });
});

describe("CppToolsIntegration", () => {
  it("does not even talk to the C/C++ extension without extra include paths", async () => {
    await integration().refresh();
    expect(calls.apiRequests).toBe(0);
    expect(calls.updates).toEqual([]);
  });

  it("registers when there are extra paths, explains what is missing, and writes no setting", async () => {
    config.extras = ["/opt/indigo/include"];
    await integration().refresh();
    expect(calls.registered).toHaveLength(1);
    expect(lines.join("\n")).toContain("Use as C/C++ Configuration Provider");
    expect(calls.updates).toEqual([]);
    expect(calls.messages).toEqual([]);
  });

  it("provides a configuration only for its own files and only while there are extra paths", async () => {
    config.extras = ["/opt/indigo/include"];
    await integration().refresh();
    const provider = calls.registered[0];
    expect(await provider.canProvideConfiguration({ fsPath: "/cache/shadow.c" })).toBe(true);
    expect(await provider.canProvideConfiguration({ fsPath: "/work/other.c" })).toBe(false);
    config.extras = [];
    expect(await provider.canProvideConfiguration({ fsPath: "/cache/shadow.c" })).toBe(false);
  });

  it("does nothing when the C features are off", async () => {
    config.features = false;
    config.extras = ["/opt/indigo/include"];
    await integration().refresh();
    expect(calls.apiRequests).toBe(0);
  });

  it("writes the provider to the workspace settings, and only when asked", async () => {
    await integration().useAsProvider();
    expect(calls.updates).toEqual([{ key: "default.configurationProvider", value: ID, target: 2 }]);
  });

  it("asks before replacing another provider, and leaves it alone when declined", async () => {
    config.provider = "ms-vscode.cmake-tools";
    config.modalAnswer = undefined;
    await integration().useAsProvider();
    expect(calls.updates).toEqual([]);
    config.modalAnswer = "Replace";
    await integration().useAsProvider();
    expect(calls.updates).toHaveLength(1);
  });

  it("needs an open folder, because the setting goes to the workspace", async () => {
    config.folders = undefined;
    await integration().useAsProvider();
    expect(calls.updates).toEqual([]);
    expect(calls.messages[0]).toContain("Open a folder");
  });

  it("removes only the value it wrote itself", async () => {
    config.workspaceProvider = "ms-vscode.cmake-tools";
    await integration().stopUsingAsProvider();
    expect(calls.updates).toEqual([]);
    config.workspaceProvider = ID;
    await integration().stopUsingAsProvider();
    expect(calls.updates).toEqual([{ key: "default.configurationProvider", value: undefined, target: 2 }]);
  });
});
