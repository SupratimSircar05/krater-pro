export function orderJobs(jobs) {
  return jobs.map((job) => job.id).sort();
}
