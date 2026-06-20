/** Aggregates all template-validation problems found during {@link assemble}'s validate pass. */
export class AuthoringError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Campaign template is invalid:\n- ${problems.join("\n- ")}`);
    this.name = "AuthoringError";
    this.problems = problems;
  }
}
