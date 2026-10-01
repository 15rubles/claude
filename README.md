# NimbleGate Mindset Coach

Interactive web app for the **Embracing Challenges: Team-Based Problem Studio** (LumeraPoint / NimbleGate AI scenario).
Team: Sokhna Kane, Anwar Ali, Aliaksei Bykau, Simon Kavuma, Jonathan Hopkins.

`index.html` is a single self-contained page (published as a claude.ai artifact):

- **Coach**: guided Pause → Reframe → Act → Learn flow, personalised by department
- **Job aid**: the unified one-page visual job aid
- **Toolkit**: the three micro-tools (name, target employees, when to use, how it works, growth mindset connection) with hands-on practice
- **Challenges**: three fixed-mindset challenges (why, impact, reframe) and the Day 2 department coverage review
- **Present**: slide preview, speaker notes, a speaker picker for every slide (shared with the team) and a full-screen presenting mode (arrow keys, click or swipe; N for notes, Esc to exit)

All wording lives in the CONTENT block at the top of the `<script>` so the team can edit it.

## Deploy on Render

The repo includes a Render Blueprint (`render.yaml`) for a free static site.

1. In the Render dashboard choose **New → Blueprint** and pick this repository.
2. Render reads `render.yaml`, which deploys the `web-app-ai` branch:
   - build command: `sh scripts/build.sh` (wraps `index.html` in a full HTML document into `dist/`)
   - publish directory: `dist`
3. Click **Apply**. Every push to `web-app-ai` redeploys automatically.

Setting it up by hand instead (**New → Static Site**): branch `web-app-ai`, build command `sh scripts/build.sh`, publish directory `dist`.

Note: on Render, speaker assignments in the Present tab are saved in each viewer's browser. Team-wide sharing only works on the claude.ai artifact link.
