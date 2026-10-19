const config = require('../release.config.cjs');

function getReleaseSource(required = false) {
  const owner = config.github?.owner;
  const repo = config.github?.repo;
  if (!owner && !repo && !required) return null;
  if (typeof owner !== 'string' || typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
    throw new Error('Set a valid public GitHub owner and repo in release.config.cjs before building a release.');
  }
  return { owner, repo };
}
module.exports = { getReleaseSource };
if (require.main === module) {
  const source = getReleaseSource(true);
  console.log(`Release source: https://github.com/${source.owner}/${source.repo} (build only; nothing will be uploaded)`);
}
