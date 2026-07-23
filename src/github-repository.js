export function normalizeGitHubRepositoryUrl(remote) {
  const scp = /^git@github\.com:(.+?)(?:\.git)?$/i.exec(remote.trim());
  if (scp) {
    return trimRepositoryPath(scp[1]);
  }
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }
    return trimRepositoryPath(url.pathname);
  } catch {
    return undefined;
  }
}

function trimRepositoryPath(value) {
  const repository = value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return /^[^/]+\/[^/]+$/.test(repository) ? repository : undefined;
}
