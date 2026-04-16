import { exec } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function runAgentPipeline(input) {
  return new Promise((resolve, reject) => {
    // Assuming python is available in the environment
    const pythonScript = path.join(__dirname, "agent.py");
    const escapedInput = input.replace(/"/g, '\\"'); // escape double quotes
    
    // Use python executable from the local virtual environment
    const pythonExecutable = path.join(__dirname, "..", "..", "venv", "Scripts", "python.exe");
    const command = `"${pythonExecutable}" "${pythonScript}" "${escapedInput}"`;
    
    exec(command, (error, stdout, stderr) => {
      // Try parsing stdout first, as Python might have outputted a clean JSON error before exiting
      try {
        if (stdout && stdout.trim()) {
          const result = JSON.parse(stdout);
          if (result.error) {
             return reject(new Error(result.error));
          }
          if (!error) {
             return resolve(result);
          }
        }
      } catch (parseError) {
        console.error("Failed to parse python output:", stdout);
      }

      // If we reach here, it either wasn't valid JSON or didn't have a clean error
      if (error) {
        console.error("Error executing Python script:", stderr);
        return reject(new Error("AI Agent crashed unexpectedly. Please check the backend logs."));
      }
    });
  });
}
