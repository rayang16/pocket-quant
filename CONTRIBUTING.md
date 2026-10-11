# Working together

Use Node 24. The crypto checker and tests do not need API keys.

```sh
git clone https://github.com/rayang16/pocket-quant.git
cd pocket-quant
npm run build
npm run dev
```

Read `CONTEXT.md` for the product brief and `README.md` for engine interfaces and setup.

Create a branch for each change, run `npm test`, and open a pull request into `main`. GitHub runs the tests and build on pushes and pull requests. Coordinate which files each teammate owns before editing the shared engine.

Keep API keys in your local `.env` or Vercel environment settings. `.env`, deployment metadata, and local output are ignored by Git. `public/` contains the web app and iPhone sharing assets. Run `npm test` and `npm run build` before publishing.

The repository owner can grant teammates write access under **Settings → Collaborators → Add people**. Invite each teammate's exact GitHub username.
