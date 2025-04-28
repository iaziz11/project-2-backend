const express = require("express");
const axios = require("axios");
const multer = require("multer");
const path = require("path");
const router = express.Router();
const fs = require("fs");
const vision = require("@google-cloud/vision");

const client = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`;

let spotifyAccessToken = "";
let tokenExpiresAt = 0;

// Function to get new access token
const getSpotifyAccessToken = async () => {
  if (spotifyAccessToken && Date.now() < tokenExpiresAt) {
    return spotifyAccessToken; // return cached token
  }

  const response = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.SPOTIFY_CLIENT_ID +
              ":" +
              process.env.SPOTIFY_CLIENT_SECRET
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  spotifyAccessToken = response.data.access_token;
  tokenExpiresAt = Date.now() + response.data.expires_in * 1000; // cache expiration time
  return spotifyAccessToken;
};

const upload = multer({ dest: "uploads/" });
router.post(
  "/userfile",
  upload.single("image"),
  async (req, res) => {
    const filePath = path.join(__dirname, "..", req.file.path);
    let labels;
    let dominantEmotion = "neutral";
    const songs = [];
    const spotifyResults = [];
    try {
      console.log("sending google vision");
      const [result] = await client.annotateImage({
        image: { content: require("fs").readFileSync(filePath) },
        features: [
          { type: "LABEL_DETECTION", maxResults: 5 },
          { type: "FACE_DETECTION", maxResults: 1 },
        ],
      });

      labels = result.labelAnnotations?.map((label) => label.description) || [];
      const faceData = result.faceAnnotations?.[0];

      if (faceData) {
        const emotions = [
          { emotion: "joy", likelihood: faceData.joyLikelihood },
          { emotion: "sorrow", likelihood: faceData.sorrowLikelihood },
          { emotion: "anger", likelihood: faceData.angerLikelihood },
          { emotion: "surprise", likelihood: faceData.surpriseLikelihood },
        ];
        emotions.sort(
          (a, b) =>
            likelihoodScore(b.likelihood) - likelihoodScore(a.likelihood)
        );
        dominantEmotion =
          emotions[0].likelihood !== "VERY_UNLIKELY"
            ? emotions[0].emotion
            : "neutral";
      }
    } catch (e) {
      console.log("Something went wrong with google vision");
      console.log(e.message);
    }

    console.log("recieved google vision");
    console.log("sending gemini");

    try {
      const geminiPrompt = `Detected emotion: ${dominantEmotion}. Context labels: ${labels.join(
        ", "
      )}. Recommend songs matching this mood as **Song - Artist**.`;

      const geminiResponse = await axios.post(GEMINI_API_URL, {
        contents: [
          {
            parts: [{ text: geminiPrompt }],
          },
        ],
      });

      const recommendationsText =
        geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      const regex = /\*\*\s*(.*?)\s*-\s*(.*?)\s*\*\*/g;
      let match;
      while ((match = regex.exec(recommendationsText)) !== null) {
        songs.push({ song: match[1].trim(), artist: match[2].trim() });
      }
      console.log("recieved gemini");
      console.log("sending spotify");
    } catch (e) {
      console.log("Something went wrong with gemini");
      console.log(e.message);
    }
    try {
      const spotifyToken = await getSpotifyAccessToken();

      for (const { song, artist } of songs) {
        try {
          const searchQuery = `${song} ${artist}`;
          const spotifySearchResponse = await axios.get(
            "https://api.spotify.com/v1/search",
            {
              headers: { Authorization: `Bearer ${spotifyToken}` },
              params: { q: searchQuery, type: "track", limit: 1 },
            }
          );
          const track = spotifySearchResponse.data.tracks.items[0];
          if (track) {
            spotifyResults.push({
              song,
              artist,
              spotifyUrl: track.external_urls.spotify,
            });
          }
        } catch (err) {
          console.warn(`Spotify search failed for ${song} - ${artist}`);
        }
      }
    } catch (e) {
      console.log("Something went wrong with spotify");
      console.log(e.message);
    }
    console.log("recieved spotify");
    console.log(spotifyResults);
    try {
      // Generate Story
      const storyPrompt = `Detected emotion: ${dominantEmotion}. Context labels: ${labels.join(
        ", "
      )}. Write a short story that reflects this mood and setting.`;
      const storyResponse = await axios.post(GEMINI_API_URL, {
        contents: [
          {
            parts: [{ text: storyPrompt }],
          },
        ],
      });

      const storyText =
        storyResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      res.json({
        labels,
        dominantEmotion,
        musicRecommendations: spotifyResults,
        story: storyText,
      });
    } catch (e) {
      console.log("Something went wrong with gemini (2)");
      console.log(e.message);
    }
  }
  // catch (error) {
  //   console.error(
  //     "Error analyzing image:",
  //     error.response?.data || error.message
  //   );
  //   console.log(error.message);
  //   res.status(500).json({
  //     message: "Failed to analyze image",
  //     error: error.response?.data || error.message,
  //   });
  // }
  //}
);

function likelihoodScore(likelihood) {
  const levels = {
    VERY_UNLIKELY: 0,
    UNLIKELY: 1,
    POSSIBLE: 2,
    LIKELY: 3,
    VERY_LIKELY: 4,
  };
  return levels[likelihood] || 0;
}

module.exports = router;
