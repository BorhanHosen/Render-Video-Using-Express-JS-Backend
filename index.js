// server.js (or your main Express file)
import express from "express";
import { exec as execCallback } from "child_process"; // Use callback version for potential cleanup
import util from "util";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid"; // For generating unique filenames
import { fileURLToPath } from "url"; // To get __dirname in ES Modules

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3001; // Backend port
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define where Remotion project lives relative to this server file
// ADJUST THIS PATH CAREFULLY!
const remotionProjectDir = path.resolve(__dirname, "../frontend"); // Example: if remotion project is one level up
const remotionEntryPoint = path.join(
  remotionProjectDir,
  "src/remotion/index.js"
); // Default entry point

// Define where rendered videos will be temporarily stored
const outputDir = path.resolve(__dirname, "output");
// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`Created output directory: ${outputDir}`);
}

// Middleware to parse JSON request bodies
app.use(express.json());
// --- End Configuration ---

// --- Helper function to run exec with proper error handling ---
// Note: Using exec directly can be risky if input isn't sanitized.
// Consider using spawn for more control if needed.
const execPromise = util.promisify(execCallback);

async function runRemotionRender(compositionId, outputPath, inputProps) {
  const propsString = JSON.stringify(inputProps || {});
  // Escape single quotes within the props string for shell safety
  const escapedPropsString = propsString.replace(/'/g, "'\\''");

  // Construct the command carefully
  // Ensure paths are correct and properly quoted if they contain spaces
  const command = `npx remotion render "${remotionEntryPoint}" ${compositionId} "${outputPath}"`;

  console.log(`Executing Remotion command: ${command}`);

  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: remotionProjectDir,
    }); // Run command from the project directory
    console.log("Remotion stdout:", stdout);
    if (stderr) {
      // Remotion often uses stderr for progress/info too, check carefully
      console.warn("Remotion stderr:", stderr);
      // You might want to check stderr for specific error messages
      if (stderr.toLowerCase().includes("error")) {
        throw new Error(`Remotion rendering failed. Stderr: ${stderr}`);
      }
    }
    console.log(`Video rendered successfully to ${outputPath}`);
    return true; // Indicate success
  } catch (error) {
    console.error(`Error executing Remotion: ${error.message}`);
    console.error(`Stderr: ${error.stderr}`); // stderr might contain useful error details from Remotion/FFmpeg
    console.error(`Stdout: ${error.stdout}`);
    throw error; // Re-throw the error to be caught by the route handler
  }
}

// --- API Endpoint ---
app.post("/api/render-and-download", async (req, res) => {
  const { compositionId, inputProps } = req.body;

  if (!compositionId) {
    return res.status(400).json({ message: "compositionId is required." });
  }

  const uniqueFilename = `${uuidv4()}-${compositionId}.mp4`;
  const outputPath = path.join(outputDir, uniqueFilename);
  const finalDownloadName = `${compositionId}-${Date.now()}.mp4`; // User-friendly download name

  console.log(`Starting render for composition: ${compositionId}`);
  console.log(`Input Props:`, inputProps);
  console.log(`Output Path: ${outputPath}`);

  try {
    // Trigger the Remotion render process and wait for it to complete
    await runRemotionRender(compositionId, outputPath, inputProps);

    // Once rendering is successful, send the file for download
    res.download(outputPath, finalDownloadName, (err) => {
      if (err) {
        console.error(`Error sending file "${outputPath}" for download:`, err);
        // Avoid sending another response if headers already sent
        if (!res.headersSent) {
          res.status(500).json({ message: "Error sending the rendered file." });
        }
      } else {
        console.log(`File "${outputPath}" sent successfully.`);
      }

      // --- Cleanup ---
      // IMPORTANT: Delete the temporary file after sending (or attempting to send)
      fs.unlink(outputPath, (unlinkErr) => {
        if (unlinkErr) {
          console.error(
            `Error deleting temporary file "${outputPath}":`,
            unlinkErr
          );
        } else {
          console.log(`Temporary file "${outputPath}" deleted.`);
        }
      });
      // --- End Cleanup ---
    });
  } catch (error) {
    console.error("Render process failed:", error.message);
    // Ensure the potentially partially created file is deleted on error
    if (fs.existsSync(outputPath)) {
      fs.unlink(outputPath, (unlinkErr) => {
        if (unlinkErr)
          console.error(
            `Error deleting file after render failure "${outputPath}":`,
            unlinkErr
          );
      });
    }
    if (!res.headersSent) {
      res
        .status(500)
        .json({ message: "Video rendering failed.", error: error.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Backend server listening on port ${PORT}`);
});
