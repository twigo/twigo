import type { Condition, Overview, Section, Value } from "../generated";
import { hash, type Cluster, type CronJob, type Job } from "./cluster";
import { CRONJOB_COLUMNS, JOB_COLUMNS } from "./fixtures";
import { cronJobCells, jobCells } from "./kinds";
import {
  ago,
  amended,
  created,
  event,
  fieldText,
  printed,
  printedCell,
  swapped,
  text,
  withEvents,
  withFields,
  words,
} from "./sections";

const iso = (moment: number): string => new Date(moment).toISOString();

/** `1m 5s`, `3h 2m`, as the core says a duration. */
function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const [hours, minutes] = [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
  ];
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return minutes > 0
    ? `${String(minutes)}m ${String(seconds % 60)}s`
    : `${String(seconds)}s`;
}

function templated(
  page: Overview,
  id: string,
  container: string,
  image: string,
): Overview {
  return amended(page, id, (section) => ({
    ...section,
    summary: words(image.split("/").pop() ?? image),
    blocks: section.blocks.map((block) =>
      block.type === "containers"
        ? {
            ...block,
            containers: block.containers.map((card) => ({
              ...card,
              name: container,
              image,
            })),
          }
        : block,
    ),
  }));
}

function recordedImage(recorded: Overview, id: string): string | undefined {
  return recorded.sections
    .filter((section) => section.id === id)
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "containers" ? block.containers : []))
    .map((card) => card.image)[0];
}

/** What the Job controller writes of a Job's `spec.suspend`, a state whichever its status. */
function suspension(
  status: string,
  reason: string,
  message: string,
  moment: number,
): Condition {
  return {
    type: "Suspended",
    status,
    tone: "neutral",
    reason,
    message,
    lastTransition: iso(moment),
    lastHeartbeat: null,
    explained: false,
  };
}

/** The Job the mock has: its moments, state, selector and template as its row says them. */
export function jobPage(recorded: Overview, job: Job): Overview {
  const header = {
    ...recorded.header,
    printed: printed(JOB_COLUMNS, jobCells(job, false)),
  };
  const done = job.completed;
  const pairs = new Map<string, string>();
  const whole = new Map<string, string>();
  const uid = fieldText(recorded, "UID");
  if (uid !== undefined) pairs.set(uid, job.id);
  const name = fieldText(recorded, "Name");
  if (name !== undefined) whole.set(name, job.name);
  const image = recordedImage(recorded, "core.template");
  if (image !== undefined)
    pairs.set(image, printedCell({ ...recorded, header }, "Images") ?? "");
  let page = created(
    { ...swapped(recorded, pairs, whole), header },
    job.created,
  );
  page = amended(page, "core.job", (section): Section => {
    const kept = withFields(section, (fields) => [
      ...fields.filter(({ label }) =>
        [
          "Parallelism",
          "Completions",
          "Completion mode",
          "Backoff limit",
          "TTL after finished",
        ].includes(label),
      ),
      ...(job.suspend
        ? [{ label: "Suspend", value: text("true"), default: false }]
        : []),
      ...(job.started === null
        ? []
        : [
            {
              label: "Started",
              value: { type: "time", at: iso(job.started) } as Value,
              default: false,
            },
          ]),
      ...(done === null
        ? []
        : [
            {
              label: "Completed",
              value: { type: "time", at: iso(done) } as Value,
              default: false,
            },
            {
              label: "Duration",
              value: text(duration(done - (job.started ?? done))),
              default: false,
            },
          ]),
      {
        label: "Pods",
        value: text(
          done !== null
            ? "0 active (0 ready) | 1 succeeded | 0 failed"
            : job.suspend
              ? "0 active (0 ready) | 0 succeeded | 0 failed"
              : "1 active (1 ready) | 0 succeeded | 0 failed",
        ),
        default: false,
      },
      {
        label: "Selector",
        value: { type: "code", text: printedCell(page, "Selector") ?? "" },
        default: false,
      },
    ]);
    return {
      ...kept,
      summary:
        done === null
          ? words("0/1 completions")
          : [...words("complete "), ago(done)],
    };
  });
  page = amended(page, "core.pods", (section) => ({
    ...section,
    summary:
      done !== null
        ? words("1 succeeded")
        : job.suspend
          ? []
          : words("1 active"),
  }));
  page = {
    ...page,
    sections: page.sections.flatMap((section): Section[] => {
      if (section.id !== "core.conditions") return [section];
      if (done !== null) {
        return [
          {
            ...section,
            blocks: section.blocks.map((block) =>
              block.type === "conditions"
                ? {
                    ...block,
                    conditions: block.conditions.map(
                      (condition): Condition => ({
                        ...condition,
                        lastTransition: iso(done),
                      }),
                    ),
                  }
                : block,
            ),
          },
        ];
      }
      const stated = job.suspend
        ? suspension(
            "True",
            "JobSuspended",
            "Job suspended",
            job.suspendedAt ?? job.created,
          )
        : job.resumedAt !== null
          ? suspension("False", "JobResumed", "Job resumed", job.resumedAt)
          : null;
      return stated
        ? [
            {
              ...section,
              summary: [],
              blocks: [{ type: "conditions", conditions: [stated] }],
            },
          ]
        : [];
    }),
  };
  page = templated(
    page,
    "core.template",
    printedCell(page, "Containers") ?? "",
    printedCell(page, "Images") ?? "",
  );
  const pod = (of: string) =>
    `${job.name}-${hash(of).toString(36).slice(0, 5)}`;
  const [first, second] = [pod(job.id), pod(`${job.id}/resumed`)];
  return withEvents(page, [
    ...(job.resumedAt === null
      ? []
      : [
          event("job-controller", "Resumed", "Job resumed", job.resumedAt),
          event(
            "job-controller",
            "SuccessfulCreate",
            `Created pod: ${second}`,
            job.resumedAt,
          ),
        ]),
    ...(job.suspendedAt === null
      ? []
      : [
          event(
            "job-controller",
            "Suspended",
            "Job suspended",
            job.suspendedAt,
          ),
          event(
            "job-controller",
            "SuccessfulDelete",
            `Deleted pod: ${job.resumedAt !== null && job.resumedAt < job.suspendedAt ? second : first}`,
            job.suspendedAt,
          ),
        ]),
    ...(done === null
      ? []
      : [event("job-controller", "Completed", "Job completed", done)]),
    event(
      "job-controller",
      "SuccessfulCreate",
      `Created pod: ${first}`,
      job.created,
    ),
  ]);
}

/** The CronJob the mock has: its schedule, moments and jobs as its row and the mock's Jobs say them. */
export function cronJobPage(
  recorded: Overview,
  cronJob: CronJob,
  cluster: Cluster,
): Overview {
  const header = {
    ...recorded.header,
    printed: printed(CRONJOB_COLUMNS, cronJobCells(cluster, cronJob, false)),
  };
  const jobs = cluster.jobs
    .filter(
      (job) =>
        job.namespace === cronJob.namespace && job.owner === cronJob.name,
    )
    .sort((a, b) => b.created - a.created);
  const made = jobs.filter((job) => !job.triggered);
  const active = made.filter((job) => job.completed === null);
  const succeeded = Math.max(
    0,
    ...jobs.flatMap((job) => (job.completed === null ? [] : [job.completed])),
  );
  const pairs = new Map<string, string>();
  const image = recordedImage(recorded, "core.jobtemplate");
  if (image !== undefined)
    pairs.set(image, printedCell({ ...recorded, header }, "Images") ?? "");
  const name = fieldText(recorded, "Name");
  const whole = new Map<string, string>();
  if (name !== undefined) whole.set(name, cronJob.name);
  let page = created(
    { ...swapped(recorded, pairs, whole), header },
    cronJob.created,
  );
  page = amended(page, "core.cronjob", (section) => ({
    ...withFields(section, (fields) =>
      fields.map((field) => {
        switch (field.label) {
          case "Schedule":
            return {
              ...field,
              value: { type: "code", text: cronJob.schedule },
            };
          case "Suspend":
            return {
              ...field,
              value: cronJob.suspend
                ? { type: "toned", text: "true", tone: "warning" }
                : text("false"),
            };
          case "Last schedule":
            return {
              ...field,
              value: { type: "time", at: iso(cronJob.lastSchedule) },
            };
          case "Last success":
            return {
              ...field,
              value:
                succeeded === 0
                  ? text("never")
                  : { type: "time", at: iso(succeeded) },
            };
          case "Active jobs":
            return {
              ...field,
              value:
                active.length === 0
                  ? text("none")
                  : {
                      type: "list",
                      items: active.map((job): Value => ({
                        type: "link",
                        target: {
                          group: "batch",
                          version: "v1",
                          kind: "Job",
                          namespace: job.namespace,
                          name: job.name,
                        },
                        text: job.name,
                      })),
                    },
            };
          default:
            return field;
        }
      }),
    ),
    summary: [
      ...words(`${cronJob.schedule} · last run `),
      ago(cronJob.lastSchedule),
    ],
  }));
  page = amended(page, "core.jobs", (section) => ({
    ...section,
    summary: active.length > 0 ? words(`${String(active.length)} active`) : [],
  }));
  page = templated(
    page,
    "core.jobtemplate",
    printedCell(page, "Containers") ?? "",
    printedCell(page, "Images") ?? "",
  );
  return withEvents(page, [
    ...made.flatMap((job) => [
      event(
        "cronjob-controller",
        "SuccessfulCreate",
        `Created job ${job.name}`,
        job.created,
      ),
      ...(job.completed === null
        ? []
        : [
            event(
              "cronjob-controller",
              "SawCompletedJob",
              `Saw completed job: ${job.name}, condition: Complete`,
              job.completed,
            ),
          ]),
    ]),
    ...jobs
      .filter((job) => job.triggered)
      .map((job) =>
        event(
          "cronjob-controller",
          "UnexpectedJob",
          `Saw a job that the controller did not create or forgot: ${job.name}`,
          job.created,
          { type: "Warning" },
        ),
      ),
  ]);
}
