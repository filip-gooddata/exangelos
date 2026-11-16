# Browser experiment review

The browser experiment is not part of the release runtime. Its tests construct synthetic DOM fixtures. Run them as documented in README.md with a separately supplied Playwright installation.

Review focus: row selection, incomplete rendering, duplicate timestamps, transient DOM state and privacy-preserving aggregate output. Passing fixtures does not establish reliable coverage of a live Slack page.
