import { amendProject, approveProject, createProject, expectedState, exportProject, importProject, replayProject, withdrawApproval } from "./core.mjs";

export class WorkspaceController {
  #project = null;
  #generation = 0;
  #custody = 0;
  #session = 0;
  #importRequest = 0;

  get project() { return this.#project; }
  get generation() { return this.#generation; }
  get session() { return this.#session; }
  get state() { return this.#project ? replayProject(this.#project) : null; }

  reset() {
    this.#project = null;
    this.#generation += 1; this.#custody += 1; this.#session += 1; this.#importRequest += 1;
  }

  replaceWithNew(input) {
    this.#project = createProject(input);
    this.#generation += 1;
    this.#custody += 1;
    this.#session += 1;
    this.#importRequest += 1;
    return this.state;
  }

  captureAction() {
    if (!this.#project) throw new Error("No project is open");
    return { generation: this.#generation, session: this.#session, ...expectedState(this.#project) };
  }

  #apply(token, operation) {
    if (token.generation !== this.#generation) throw Object.assign(new Error("This action belongs to an older workspace session. Nothing was applied."), { code: "stale_session" });
    this.#project = operation(this.#project, token);
    this.#generation += 1;
    this.#custody += 1;
    return this.state;
  }

  amend(token, event) { return this.#apply(token, (project, expected) => amendProject(project, expected, event)); }
  approve(token, event) { return this.#apply(token, (project, expected) => approveProject(project, expected, event)); }
  withdraw(token, event) { return this.#apply(token, (project, expected) => withdrawApproval(project, expected, event)); }
  exportText() { if (!this.#project) throw new Error("No project is open"); return exportProject(this.#project); }
  touchDraft() { this.#custody += 1; }

  beginImport() {
    this.#importRequest += 1;
    return { request: this.#importRequest, generation: this.#generation, custody: this.#custody, sequence: this.state?.sequence ?? 0 };
  }

  parseImport(text) { return importProject(text); }

  assertImportCurrent(token) {
    if (token.request !== this.#importRequest || token.generation !== this.#generation || token.custody !== this.#custody || token.sequence !== (this.state?.sequence ?? 0)) throw Object.assign(new Error("A newer action changed the workspace. The delayed import was not applied."), { code: "stale_import" });
  }

  adoptImport(token, parsedProject, confirmed) {
    this.assertImportCurrent(token);
    this.#importRequest += 1;
    if (this.#project && !confirmed) return { adopted: false, reason: "cancelled" };
    this.#project = replayProject(parsedProject).project;
    this.#generation += 1;
    this.#custody += 1;
    this.#session += 1;
    return { adopted: true, state: this.state };
  }
}
