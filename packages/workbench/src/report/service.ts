import type { Backend, Report } from "@twigo/protocol";
import { Changes } from "../changes";

/**
 * The window's "Report a Problem" (ARCHITECTURE 4.10): Rust prepares and
 * redacts the report when the dialog opens, and the dialog shows it until it
 * closes. A window-level dialog, not an editor, since no space may be open.
 */
export class ProblemReport {
  readonly changes = new Changes();
  #report: Report | undefined;
  #preparing = false;

  constructor(private readonly backend: Backend) {}

  get report(): Report | undefined {
    return this.#report;
  }

  async show(): Promise<void> {
    if (this.#report || this.#preparing) return;
    this.#preparing = true;
    try {
      this.#report = await this.backend.invoke("report_problem", null);
      this.changes.emit();
    } finally {
      this.#preparing = false;
    }
  }

  close(): void {
    if (!this.#report) return;
    this.#report = undefined;
    this.changes.emit();
  }
}
