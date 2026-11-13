import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import * as vscode from "vscode";
import { type CppToolsApi, type CustomConfigurationProvider, getCppToolsApi, Version } from "vscode-cpptools";

import type { ShadowSource } from "./shadow";

const SYSTEM_INCLUDES = process.platform === "win32" ? [] : ["/usr/include", "/usr/local/include"];
const PROVIDER_SETTING = "default.configurationProvider";

function expand(path: string, folder: string | undefined): string {
  const home = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return home.replace(/\$\{workspaceFolder\}/g, folder ?? "");
}

/** Include directories for the generated source: the driver folder, the configured extras, the system ones. */
export function buildIncludePath(origin: string, extras: string[], folder: string | undefined): string[] {
  // Without a workspace folder `${workspaceFolder}` stands for nothing: such an entry would become `/include`.
  const usable = extras.filter((path) => folder !== undefined || !path.includes("${workspaceFolder}"));
  return [...new Set([origin, ...usable.map((path) => expand(path, folder)), ...SYSTEM_INCLUDES])];
}

function findCompiler(): string | undefined {
  const configured = vscode.workspace.getConfiguration("C_Cpp").get<string>("default.compilerPath", "");
  if (configured.trim() !== "") {
    return configured;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["gcc", "cc", "clang", "gcc.exe", "clang.exe"]) {
      if (directory && existsSync(join(directory, name))) {
        return join(directory, name);
      }
    }
  }
  return undefined;
}

const extraIncludePaths = () => vscode.workspace.getConfiguration("indigoDriver").get<string[]>("includePaths", []);

/**
 * Tells Microsoft C/C++ about the include paths of `indigoDriver.includePaths` when it analyzes the generated
 * sources. Without extra paths none of this is needed: the C/C++ extension finds the headers in the system
 * include directories by itself.
 *
 * The C/C++ extension asks a provider only if it is set as its configuration provider. Nothing here writes that
 * setting on its own: the user runs a command, which writes it to the workspace settings.
 */
export class CppToolsIntegration implements vscode.Disposable {
  #api?: CppToolsApi;
  #provider?: CustomConfigurationProvider;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly shadow: ShadowSource,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Register with the C/C++ extension, but only while there are extra include paths to give it. */
  async refresh() {
    const wanted = vscode.workspace.getConfiguration("indigoDriver").get<boolean>("cLanguageFeatures", false);
    if (this.#provider) {
      this.includePathsChanged();
      return;
    }
    if (!wanted || extraIncludePaths().length === 0) {
      return;
    }
    await this.#register();
    if (!this.#isDefaultProvider()) {
      this.output.appendLine(
        "'indigoDriver.includePaths' has no effect until INDIGO Driver is the C/C++ configuration provider: run 'INDIGO Driver: Use as C/C++ Configuration Provider'.",
      );
    }
  }

  async #register() {
    const api = await getCppToolsApi(Version.v5);
    if (!api) {
      this.output.appendLine("The extra include paths need the C/C++ extension (ms-vscode.cpptools).");
      return;
    }
    const provider: CustomConfigurationProvider = {
      name: "INDIGO Driver",
      extensionId: this.context.extension.id,
      canProvideConfiguration: async (uri) =>
        extraIncludePaths().length > 0 && this.shadow.originOf(uri.fsPath) !== undefined,
      provideConfigurations: async (uris) =>
        uris.map((uri) => {
          const origin = this.shadow.originOf(uri.fsPath) ?? "";
          const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(origin))?.uri.fsPath;
          return {
            uri,
            configuration: {
              includePath: buildIncludePath(origin, extraIncludePaths(), folder),
              defines: [] as string[],
              standard: uri.fsPath.endsWith(".cpp") ? "gnu++17" : "gnu11",
              compilerPath: findCompiler(),
            },
          };
        }),
      canProvideBrowseConfiguration: async () => false,
      provideBrowseConfiguration: async () => null,
      canProvideBrowseConfigurationsPerFolder: async () => false,
      provideFolderBrowseConfiguration: async () => null,
      dispose: () => {},
    };
    api.registerCustomConfigurationProvider(provider);
    api.notifyReady(provider);
    this.#api = api;
    this.#provider = provider;
  }

  includePathsChanged() {
    if (this.#api && this.#provider) {
      this.#api.didChangeCustomConfiguration(this.#provider);
    }
  }

  #isDefaultProvider(): boolean {
    return vscode.workspace.getConfiguration("C_Cpp").get<string>(PROVIDER_SETTING, "") === this.context.extension.id;
  }

  /** Command: make INDIGO Driver the C/C++ configuration provider of this workspace. */
  async useAsProvider() {
    const id = this.context.extension.id;
    if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
      vscode.window.showWarningMessage("Open a folder first: the setting is written to the workspace settings.");
      return;
    }
    const cpp = vscode.workspace.getConfiguration("C_Cpp");
    const current = cpp.get<string>(PROVIDER_SETTING, "");
    if (current === id) {
      vscode.window.showInformationMessage("INDIGO Driver is already the C/C++ configuration provider.");
      return;
    }
    if (current !== "") {
      const replace = "Replace";
      const choice = await vscode.window.showWarningMessage(
        `'${current}' is the C/C++ configuration provider of this workspace. Replace it with INDIGO Driver? Its include paths will no longer reach the C/C++ extension, and stopping later will not bring it back.`,
        { modal: true },
        replace,
      );
      if (choice !== replace) {
        return;
      }
    }
    await cpp.update(PROVIDER_SETTING, id, vscode.ConfigurationTarget.Workspace);
    await this.refresh();
    vscode.window.showInformationMessage(
      "INDIGO Driver is now the C/C++ configuration provider of this workspace (see 'C_Cpp.default.configurationProvider' in the workspace settings).",
    );
  }

  /** Command: undo useAsProvider, leaving a provider chosen by someone else alone. */
  async stopUsingAsProvider() {
    const cpp = vscode.workspace.getConfiguration("C_Cpp");
    if (cpp.inspect<string>(PROVIDER_SETTING)?.workspaceValue !== this.context.extension.id) {
      vscode.window.showInformationMessage(
        "INDIGO Driver is not set as the C/C++ configuration provider of this workspace.",
      );
      return;
    }
    await cpp.update(PROVIDER_SETTING, undefined, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage("The C/C++ configuration provider setting of this workspace was removed.");
  }

  dispose() {
    this.#provider = undefined;
    this.#api?.dispose();
  }
}
