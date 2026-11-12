import { baseIgnores, markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

export default markdownlint({
  // skills/ ships in the CLI package and is served by the site, so linting it would change
  // published content. plugins/ reaches the same files through a symlink. Built output holds
  // copies of the skills, so it is skipped too.
  ignores: [...baseIgnores, 'skills/**', 'plugins/**', '**/dist/**'],
  // The two README headers centre the logo and tagline with these elements.
  config: { MD033: { allowed_elements: ['p', 'img', 'strong', 'br'] } }
});
