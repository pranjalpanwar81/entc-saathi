# ENTC Saathi 📡

**An AI exam tutor for Electronics & Telecommunication (ENTC / ECE) students. Snap a photo of your handwritten answer and get it graded like a university examiner would.**

Powered by the **BharatCode model API** · Built for the **BharatCode Build League**

<!-- Add your live link here after deploying: **Try it live → https://your-app.onrender.com** -->

---

## Why

Most AI study tools are built for CS students. ENTC students work with circuits, signals, communication systems and microcontrollers, and they study for exams that are mostly **handwritten numericals and vivas**. Generic chatbots don't mark the way examiners do, and they can't see your answer sheet.

ENTC Saathi is built for how ENTC students actually study.

## Features

| | Feature | What it does |
|---|---|---|
| 🧮 | **Exact numericals** | Language models are bad at arithmetic. ENTC Saathi never lets the model guess a number: it calls real calculator tools (RC filter, RLC resonance, op-amp gain, 555 timer, voltage divider, resistor networks, dB and a general calculator) and shows every verified calculation. |
| 📷 | **Photo grading** | Snap or paste a photo of your handwritten working. You get a score, line-by-line ✅/❌ marking, the corrected solution and a tip. |
| 📘 | **Explain** | Intuition → key formulas → a solved exam-style numerical → common mistakes → likely exam questions |
| 📝 | **Quiz me** | One question at a time with marks. It grades your answer (typed or photographed) and the difficulty adapts to you. |
| 🎤 | **Viva practice** | A mock external examiner asks 6 probing questions about your lab experiment, then scores you out of 10 |
| 🎓 | **University-aware** | Pick SPPU, Mumbai University, VTU, AKTU, GTU, Anna University and more to match the exam style |
| 🗣️ | **Hinglish mode** | Explanations in the way students actually talk, with technical terms kept in English |
| ⚡ | **Streaming answers** | Text appears as it is written, so there's no waiting on a spinner |
| 💾 | **Remembers your session** | Refreshing the page doesn't lose your conversation |

13 subjects: Network Theory, Analog Circuits, Digital Electronics, Signals & Systems, Control Systems, Microcontrollers (8051/ARM), Analog & Digital Communication, Electromagnetics & Antennas, DSP, VLSI, Embedded Systems, Power Electronics and Computer Networks.

## How it works

```
Browser (index.html)          Node server (server.js)                 BharatCode API
 • chat UI, modes, settings ─▶ • builds the tutor prompt            ─▶ qwen-3.8-27b
 • photo resize (≤1600px)      • tool loop: model asks for a         /chat/completions
 • shows verified calcs     ◀─   calculation → tools.js computes  ◀─ (stream, tools, image input)
                                 it exactly → result goes back to
                                 the model → final answer streams
                               • keeps the API key on the server
                               • retries when the model is busy (503)
```

- Uses BharatCode's OpenAI-compatible `/chat/completions` endpoint with **streaming**, **function calling** and **image input**.
- `tools.js` has a safe expression parser (no `eval`) that understands engineering suffixes like `10k`, `0.1u` and `4.7n`, plus 7 ENTC formula tools. The model can call tools over several rounds, and bad inputs are returned to it as errors so it can correct itself.
- Unit tests: `node --test`
- **Zero dependencies.** It only needs Node.js 18 or newer, with no `npm install`.
- The API key never reaches the browser. Photos are resized in the browser and only the latest one is sent, so requests stay small.

## Run it locally

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. Get your developer API key from https://bharatcode.ai/account (API access needs Lite, Pro or verified student access).
3. In this folder, create a file named `.env` containing:
   ```
   BHARATCODE_API_KEY=bc_live_your_key_here
   ```
4. Start it:
   ```
   node server.js
   ```
5. Open http://localhost:3000

Optional settings (in `.env`): `PORT`, `BHARATCODE_MODEL` (default `qwen-3.8-27b`), `DEMO_MODE=1` (UI only, no API calls).

## Deploy (free)

The repo includes `render.yaml`. On [Render](https://render.com), choose **New → Blueprint**, pick this repo and paste your `BHARATCODE_API_KEY` when asked. Any Node host works: start command `node server.js`, health check `/healthz`.

## Project files

| File | Purpose |
|---|---|
| `server.js` | HTTP server, tutor prompts, streaming BharatCode API call with the tool loop |
| `tools.js` | Calculator tools and the safe expression evaluator |
| `test/tools.test.js` | Unit tests for every tool (`node --test`) |
| `index.html` | The whole web UI (chat, photo upload, modes, Markdown rendering) |
| `render.yaml` | One-click deploy config |
| `BharatCode.txt` | Hackathon entry marker |

## Roadmap

- Track weak topics across sessions and suggest revision
- Previous-year question paper practice per university
- Circuit diagram → explanation (draw a circuit, get its analysis)

## Disclaimer

AI answers can be wrong. Always cross-check with your textbook and faculty.

## License

MIT © Pranjal Panwar
