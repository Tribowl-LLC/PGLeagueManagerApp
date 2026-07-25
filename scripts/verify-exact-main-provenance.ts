type JsonRecord = Record<string, unknown>;

export {};

const repository = process.env.GITHUB_REPOSITORY;
const certifiedSha = process.env.CERTIFIED_SHA;
const token = process.env.GITHUB_TOKEN;

if (!repository || !certifiedSha || !token) {
  throw new Error('GITHUB_REPOSITORY, CERTIFIED_SHA, and GITHUB_TOKEN are required.');
}

const [owner, repo] = repository.split('/');
if (!owner || !repo || !/^[0-9a-f]{40}$/.test(certifiedSha)) {
  throw new Error('Repository identity or certified SHA is invalid.');
}

async function githubApi(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${path}.`);
  }

  return response.json();
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is not a non-empty string.`);
  }
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is not an integer.`);
  }
  return value;
}

async function commitTree(sha: string): Promise<string> {
  const commit = asRecord(
    await githubApi(`/repos/${owner}/${repo}/git/commits/${sha}`),
    `commit ${sha}`,
  );
  const tree = asRecord(commit.tree, `commit ${sha} tree`);
  return asString(tree.sha, `commit ${sha} tree SHA`);
}

interface SuccessfulRun {
  id: number;
  headSha: string;
  htmlUrl: string;
}

async function findSuccessfulRun(workflow: string, headSha: string): Promise<SuccessfulRun> {
  const query = new URLSearchParams({
    event: 'pull_request',
    head_sha: headSha,
    status: 'success',
    per_page: '100',
  });
  const response = asRecord(
    await githubApi(`/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?${query}`),
    `${workflow} workflow runs`,
  );
  const runs = asArray(response.workflow_runs, `${workflow} workflow runs`)
    .map((run) => asRecord(run, `${workflow} run`))
    .filter((run) => run.event === 'pull_request' && run.conclusion === 'success')
    .sort((left, right) => asNumber(right.id, 'run id') - asNumber(left.id, 'run id'));
  const run = runs[0];
  if (!run) throw new Error(`No successful pull_request run of ${workflow} exists for ${headSha}.`);

  return {
    id: asNumber(run.id, `${workflow} run id`),
    headSha: asString(run.head_sha, `${workflow} run head SHA`),
    htmlUrl: asString(run.html_url, `${workflow} run URL`),
  };
}

async function requireSuccessfulJobs(run: SuccessfulRun, requiredNames: readonly string[]): Promise<void> {
  const response = asRecord(
    await githubApi(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`),
    `jobs for run ${run.id}`,
  );
  const jobs = asArray(response.jobs, `jobs for run ${run.id}`).map((job) =>
    asRecord(job, `job in run ${run.id}`),
  );

  for (const name of requiredNames) {
    const matchingJob = jobs.find((job) => job.name === name);
    if (!matchingJob || matchingJob.conclusion !== 'success') {
      throw new Error(`Required job ${name} was not successful in run ${run.id}.`);
    }
  }
}

const pulls = asArray(
  await githubApi(`/repos/${owner}/${repo}/commits/${certifiedSha}/pulls`),
  'associated pull requests',
).map((pull) => asRecord(pull, 'associated pull request'));

const mergedPull = pulls.find((pull) => {
  const base = asRecord(pull.base, 'pull request base');
  return pull.merged_at !== null && pull.merge_commit_sha === certifiedSha && base.ref === 'main';
});
if (!mergedPull) {
  throw new Error(`Commit ${certifiedSha} is not the recorded merge commit of a pull request into main.`);
}

const pullNumber = asNumber(mergedPull.number, 'pull request number');
const head = asRecord(mergedPull.head, 'pull request head');
const pullHeadSha = asString(head.sha, 'pull request head SHA');
const [mainTree, pullTree] = await Promise.all([
  commitTree(certifiedSha),
  commitTree(pullHeadSha),
]);
if (mainTree !== pullTree) {
  throw new Error(
    `Main tree ${mainTree} does not match merged pull request #${pullNumber} tree ${pullTree}.`,
  );
}

const [ciRun, raceRun] = await Promise.all([
  findSuccessfulRun('ci.yml', pullHeadSha),
  findSuccessfulRun('race-suite.yml', pullHeadSha),
]);
if (ciRun.headSha !== pullHeadSha || raceRun.headSha !== pullHeadSha) {
  throw new Error('A successful workflow run reported an unexpected head SHA.');
}

await Promise.all([
  requireSuccessfulJobs(ciRun, [
    'Type check & lint',
    'Tests',
    'Database migrations (PostgreSQL 17)',
  ]),
  requireSuccessfulJobs(raceRun, ['Race suite']),
]);

process.stdout.write(
  [
    `[exact-main] certified=${certifiedSha}`,
    `pull_request=${pullNumber}`,
    `tree=${mainTree}`,
    `ci_run=${ciRun.htmlUrl}`,
    `race_run=${raceRun.htmlUrl}`,
  ].join(' ') + '\n',
);
