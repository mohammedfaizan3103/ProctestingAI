import express from "express";
import { runAgentPipeline } from "../services/ai/orchestrator.js";

const router = express.Router();

// Debug endpoint (original)
router.post("/test-agent", async (req, res) => {
  try {
    const { prompt } = req.body;
    const result = await runAgentPipeline(prompt);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Agent failed" });
  }
});

// Primary endpoint used by the frontend exam editor
router.post("/generate-questions", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    const result = await runAgentPipeline(prompt.trim());
    res.json(result);
    } catch (error) {
    console.error("AI generation error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to generate questions. Please try again." });
  }
});

export default router;
