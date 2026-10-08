package api

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/goccy/go-json"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"codeberg.org/pluja/whishper/models"
)

func (s *Server) handleGetAllTranscriptions(c *fiber.Ctx) error {
	transcriptions := s.Db.GetAllTranscriptions()

	// Convert the transcriptions to JSON.
	json, err := json.Marshal(transcriptions)
	if err != nil {
		// 503 On vacation!
		return fiber.NewError(fiber.StatusServiceUnavailable, "On vacation!")
	}

	// Write the JSON to the response body.
	c.Set("Content-Type", "application/json")
	c.Write(json)
	return nil
}

func (s *Server) handleListTranscriptions(c *fiber.Ctx) error {
	transcriptions := s.Db.GetAllTranscriptions()

	log.Debug().Msgf("Found %v transcriptions in the database", len(transcriptions))
	// Convert the transcriptions to a lightweight view and marshal.
	items := make([]models.TranscriptionListItem, 0, len(transcriptions))
	for _, t := range transcriptions {
		if t.WordsCount == 0 && t.Result.Text != "" {
			count := len(strings.Fields(t.Result.Text))
			t.WordsCount = count
			if _, err := s.Db.UpdateTranscription(t); err != nil {
				log.Error().Err(err).Msgf("Error updating words_count for transcription %v", t.ID.Hex())
			}
		}

		item := models.TranscriptionListItem{
			ID:                      t.ID.Hex(),
			Status:                  t.Status,
			Language:                t.Language,
			ModelSize:               t.ModelSize,
			Task:                    t.Task,
			Device:                  t.Device,
			FileName:                t.FileName,
			SourceUrl:               t.SourceUrl,
			BeamSize:                t.BeamSize,
			InitialPrompt:           t.InitialPrompt,
			Hotwords:                t.Hotwords,
			VadFilter:               t.VadFilter,
			VadThreshold:            t.VadThreshold,
			VadMinSpeechDurationMS:  t.VadMinSpeechDurationMS,
			VadMinSilenceDurationMS: t.VadMinSilenceDurationMS,
			Duration:                t.Result.Duration,
			WordsCount:              t.WordsCount,
			Diarize:                 t.Diarize,
			Progress:                t.Progress,
			DownloadingModel:        t.DownloadingModel,
			Translations:            make([]models.TranslationListItem, 0, len(t.Translations)),
		}
		for _, tr := range t.Translations {
			item.Translations = append(item.Translations, models.TranslationListItem{
				SourceLanguage: tr.SourceLanguage,
				TargetLanguage: tr.TargetLanguage,
				Status:         tr.Status,
			})
		}
		items = append(items, item)
	}

	json, err := json.Marshal(items)
	if err != nil {
		// 503 On vacation!
		return fiber.NewError(fiber.StatusServiceUnavailable, "On vacation!")
	}

	// Write the JSON to the response body.
	c.Set("Content-Type", "application/json")
	c.Write(json)
	return nil
}

func (s *Server) handleGetTranscriptionById(c *fiber.Ctx) error {
	id := c.Params("id")
	t := s.Db.GetTranscription(id)
	if t == nil {
		log.Warn().Msgf("Transcription with id %v not found", id)
		return fiber.NewError(fiber.StatusNotFound, "Not found")
	}

	if t.WordsCount == 0 && t.Result.Text != "" {
		calculated := len(strings.Fields(t.Result.Text))
		t.WordsCount = calculated
		if _, err := s.Db.UpdateTranscription(t); err != nil {
			log.Error().Err(err).Msgf("Error updating words_count for transcription %v", t.ID.Hex())
		}
	}

	// Convert the transcription to JSON.
	json, err := json.Marshal(t)
	if err != nil {
		// 503 On vacation!
		return fiber.NewError(fiber.StatusServiceUnavailable, "On vacation!")
	}

	// Write the JSON to the response body.
	c.Set("Content-Type", "application/json")
	c.Write(json)
	return nil
}

// This function receives data from a form to create a new transcription.
// If the transcription is created successfully, it returns a 201 Created status code and
// broadcasts the new transcription to all ws clients.
func (s *Server) handlePostTranscription(c *fiber.Ctx) error {
	log.Debug().Msg("POST /api/transcriptions")
	var transcription models.Transcription

	// we get the filename from the from
	var filename string
	if c.FormValue("sourceUrl") == "" {
		// Get the form file from the request.
		file, err := c.FormFile("file")
		if err != nil {
			log.Error().Err(err).Msg("Error getting file field from the form")
			return fiber.NewError(fiber.StatusBadRequest, "Bad request")
		}
		timeid := time.Now().Format("2006_01_02-150405000")
		filename = timeid + models.FileNameSeparator + file.Filename
		// if it's empty and there is no sourceurl we set a timestamp-based filename
		if filename == timeid+models.FileNameSeparator {
			filename = timeid + models.FileNameSeparator + time.Now().Format("2006_01_02-150405")
		}

		// Save the file to the uploads directory.
		err = c.SaveFile(file, fmt.Sprintf("%v/%v", os.Getenv("UPLOAD_DIR"), filename))
		if err != nil {
			log.Error().Err(err).Msgf("Error saving the form file to disk into %v", os.Getenv("UPLOAD_DIR"))
			return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
		}
	}

	// Parse the body into the transcription struct.
	transcription.Language = c.FormValue("language")
	transcription.ModelSize = c.FormValue("modelSize")
	transcription.FileName = filename
	transcription.Status = models.TranscriptionStatusPending
	transcription.Task = "transcribe"
	transcription.SourceUrl = c.FormValue("sourceUrl")
	transcription.Device = c.FormValue("device")
	if transcription.Device != "cpu" && transcription.Device != "cuda" {
		log.Warn().Msgf("Device %v not supported, using cpu", transcription.Device)
		transcription.Device = "cpu"
	}
	// Parse new params
	if c.FormValue("beam_size") != "" {
		var beamSize int
		_, err := fmt.Sscanf(c.FormValue("beam_size"), "%d", &beamSize)
		if err == nil {
			transcription.BeamSize = beamSize
		}
	}
	transcription.InitialPrompt = c.FormValue("initial_prompt")
	hotwordsStr := c.FormValue("hotwords")
	if hotwordsStr != "" {
		// Split by comma and trim spaces
		var hotwords []string
		for _, hw := range SplitAndTrim(hotwordsStr, ",") {
			if hw != "" {
				hotwords = append(hotwords, hw)
			}
		}
		transcription.Hotwords = hotwords
	}
	// VAD parameters
	if c.FormValue("vad_filter") == "true" {
		transcription.VadFilter = true
	}
	if c.FormValue("vad_threshold") != "" {
		var v float64
		_, err := fmt.Sscanf(c.FormValue("vad_threshold"), "%f", &v)
		if err == nil {
			transcription.VadThreshold = &v
		}
	}
	if c.FormValue("vad_min_speech_duration_ms") != "" {
		var v int
		_, err := fmt.Sscanf(c.FormValue("vad_min_speech_duration_ms"), "%d", &v)
		if err == nil {
			transcription.VadMinSpeechDurationMS = &v
		}
	}
	if c.FormValue("vad_min_silence_duration_ms") != "" {
		var v int
		_, err := fmt.Sscanf(c.FormValue("vad_min_silence_duration_ms"), "%d", &v)
		if err == nil {
			transcription.VadMinSilenceDurationMS = &v
		}
	}
	if c.FormValue("diarize") == "true" {
		transcription.Diarize = true
	}
	if c.FormValue("min_speakers") != "" {
		var v int
		_, err := fmt.Sscanf(c.FormValue("min_speakers"), "%d", &v)
		if err == nil {
			transcription.MinSpeakers = &v
		}
	}
	if c.FormValue("max_speakers") != "" {
		var v int
		_, err := fmt.Sscanf(c.FormValue("max_speakers"), "%d", &v)
		if err == nil {
			transcription.MaxSpeakers = &v
		}
	}

	log.Debug().Msgf("Transcription: %+v", transcription)
	// Save transcription to database
	res, err := s.Db.NewTranscription(&transcription)
	if err != nil {
		log.Error().Err(err).Msg("Error saving transcription to database")
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}

	// Broadcast transcription to websocket clients
	s.BroadcastTranscription(res)
	s.NewTranscriptionCh <- true

	// Convert the transcription to JSON.
	json, err := json.Marshal(res)
	if err != nil {
		// 503 On vacation!
		return fiber.NewError(fiber.StatusServiceUnavailable, "On vacation!")
	}

	// Write the JSON to the response body.
	c.Set("Content-Type", "application/json")
	c.Write(json)
	return nil
}

// SplitAndTrim splits a string by sep and trims spaces from each part
func SplitAndTrim(s, sep string) []string {
	var out []string
	for _, part := range strings.Split(s, sep) {
		trimmed := strings.TrimSpace(part)
		out = append(out, trimmed)
	}
	return out
}

func (s *Server) handleDeleteTranscription(c *fiber.Ctx) error {
	// First get the transcription from the database
	id := c.Params("id")
	t := s.Db.GetTranscription(id)
	if t == nil {
		log.Warn().Msgf("Transcription with id %v not found", id)
		return fiber.NewError(fiber.StatusNotFound, "Not found")
	}

	// Then delete the file from disk
	err := os.Remove(fmt.Sprintf("%v/%v", os.Getenv("UPLOAD_DIR"), t.FileName))
	if err != nil {
		log.Error().Err(err).Msgf("Error deleting file %v", t.FileName)
	}

	// Finally delete the transcription from the database
	err = s.Db.DeleteTranscription(id)
	if err != nil {
		log.Error().Err(err).Msgf("Error deleting transcription %v", id)
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}

	// Return status deleted
	c.Status(fiber.StatusOK)
	return nil
}

func (s *Server) handlePatchTranscription(c *fiber.Ctx) error {
	var transcription models.Transcription
	// Parse the body into the transcription struct.
	err := json.Unmarshal(c.Body(), &transcription)
	if err != nil {
		log.Error().Err(err).Msg("Error parsing JSON body")
		return fiber.NewError(fiber.StatusBadRequest, "Bad request")
	}

	// Update the transcription in the database
	ut, err := s.Db.UpdateTranscription(&transcription)
	if err != nil {
		log.Error().Err(err).Msgf("Error updating transcription")
		if err.Error() == "no documents were modified" {
			return fiber.NewError(fiber.StatusNotModified, "Not found")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}

	// Write the JSON to the response body.
	s.BroadcastTranscription(ut)

	// Return status ok
	json, err := json.Marshal(&ut)
	if err != nil {
		// 503 On vacation!
		return fiber.NewError(fiber.StatusInternalServerError, "Error parsing json!")
	}

	c.Status(fiber.StatusOK)
	c.Write(json)
	return nil
}

func (s *Server) handleRenameFile(c *fiber.Ctx) error {
	id := c.Params("id")
	newFileName := c.FormValue("newFileName")

	if newFileName == "" {
		return fiber.NewError(fiber.StatusBadRequest, "New file name is required")
	}

	// Get the transcription from db
	transcription := s.Db.GetTranscription(id)
	if transcription == nil {
		return fiber.NewError(fiber.StatusNotFound, "Transcription not found")
	}

	// Split current filename to get timeid part
	parts := strings.Split(transcription.FileName, models.FileNameSeparator)
	if len(parts) < 2 {
		return fiber.NewError(fiber.StatusInternalServerError, "Invalid filename format")
	}
	timeid := parts[0]

	// Create new filename
	newFullFileName := timeid + models.FileNameSeparator + newFileName
	oldPath := fmt.Sprintf("%v/%v", os.Getenv("UPLOAD_DIR"), transcription.FileName)
	newPath := fmt.Sprintf("%v/%v", os.Getenv("UPLOAD_DIR"), newFullFileName)

	// Rename the file on disk
	err := os.Rename(oldPath, newPath)
	if err != nil {
		log.Error().Err(err).Msgf("Error renaming file from %v to %v", oldPath, newPath)
		return fiber.NewError(fiber.StatusInternalServerError, "Error renaming file")
	}

	// Update filename in database
	transcription.FileName = newFullFileName
	updatedTranscription, err := s.Db.UpdateTranscription(transcription)
	if err != nil {
		// Try to revert the file rename as db update failed
		os.Rename(newPath, oldPath)
		log.Error().Err(err).Msg("Error updating filename in database")
		return fiber.NewError(fiber.StatusInternalServerError, "Error updating database")
	}

	// Broadcast the change to websocket clients
	s.BroadcastTranscription(updatedTranscription)

	// Return the updated transcription
	return c.JSON(updatedTranscription)
}

func (s *Server) handleTranslate(c *fiber.Ctx) error {
	id := c.Params("id")
	targetLang := c.Params("target")

	transcription := s.Db.GetTranscription(id)

	// Set status as translating
	transcription.Status = models.TrannscriptionStatusTranslating
	s.Db.UpdateTranscription(transcription)
	s.BroadcastTranscription(transcription)

	err := transcription.Translate(targetLang)
	if err != nil {
		log.Debug().Err(err).Msg("Error with translation")
		return err
	}

	// Set as done
	transcription.Status = models.TranscriptionStatusDone
	s.Db.UpdateTranscription(transcription)
	s.BroadcastTranscription(transcription)
	return nil
}

func (s *Server) handleUploadJSON(c *fiber.Ctx) error {
	var request struct {
		TranscriptionId string      `json:"transcriptionId"`
		Result          interface{} `json:"result"`
	}

	// Parse the JSON body
	err := json.Unmarshal(c.Body(), &request)
	if err != nil {
		log.Error().Err(err).Msg("Error parsing JSON body")
		return fiber.NewError(fiber.StatusBadRequest, "Invalid JSON format")
	}

	// Validate required fields
	if request.TranscriptionId == "" {
		return fiber.NewError(fiber.StatusBadRequest, "transcriptionId is required")
	}

	if request.Result == nil {
		return fiber.NewError(fiber.StatusBadRequest, "result is required")
	}

	// Get the transcription from the database
	transcription := s.Db.GetTranscription(request.TranscriptionId)
	if transcription == nil {
		return fiber.NewError(fiber.StatusNotFound, "Transcription not found")
	}

	// Validate the JSON structure
	resultJSON, err := json.Marshal(request.Result)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid result format")
	}

	// Try to unmarshal into WhisperResult to validate structure
	var whisperResult models.WhisperResult
	err = json.Unmarshal(resultJSON, &whisperResult)
	if err != nil {
		log.Error().Err(err).Msg("Error validating JSON structure")
		return fiber.NewError(fiber.StatusBadRequest, "Invalid transcription result format")
	}

	// Basic validation - ensure required fields exist
	if whisperResult.Language == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Missing required field: language")
	}

	if whisperResult.Text == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Missing required field: text")
	}

	if len(whisperResult.Segments) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Missing required field: segments")
	}

	// Update the transcription with the new result
	transcription.Result = whisperResult
	transcription.WordsCount = len(strings.Fields(whisperResult.Text))
	updatedTranscription, err := s.Db.UpdateTranscription(transcription)
	if err != nil {
		if err.Error() == "no documents were modified" {
			return c.Status(fiber.StatusNotModified).JSON(fiber.Map{
				"message": "No changes were made",
			})
		}
		log.Error().Err(err).Msg("Error updating transcription in database")
		return fiber.NewError(fiber.StatusInternalServerError, "Error updating transcription")
	}

	// Broadcast the updated transcription to websocket clients
	s.BroadcastTranscription(updatedTranscription)

	// Return the updated transcription
	return c.JSON(updatedTranscription)
}

// maxSpeakerNameLength caps a speaker display name, in characters.
const maxSpeakerNameLength = 80

// handleUpdateSpeakerNames stores the display names the user gave to diarization
// labels. The body is the complete mapping ({"SPEAKER_00": "Alice", ...}); labels
// missing from it, or mapped to an empty name, fall back to their default name.
// Giving two labels the same name merges them into one speaker when rendered.
func (s *Server) handleUpdateSpeakerNames(c *fiber.Ctx) error {
	id := c.Params("id")
	t := s.Db.GetTranscription(id)
	if t == nil {
		log.Warn().Msgf("Transcription with id %v not found", id)
		return fiber.NewError(fiber.StatusNotFound, "Not found")
	}

	var body map[string]string
	if err := json.Unmarshal(c.Body(), &body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Body must be a JSON object of label -> name")
	}

	// Only labels the diarization actually produced can be named.
	labels := map[string]bool{}
	for _, segment := range t.Result.Segments {
		if segment.Speaker != "" {
			labels[segment.Speaker] = true
		}
	}

	names := map[string]string{}
	for label, name := range body {
		if !labels[label] {
			return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("Unknown speaker label %q", label))
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if len([]rune(name)) > maxSpeakerNameLength {
			return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("Speaker name longer than %d characters", maxSpeakerNameLength))
		}
		names[label] = name
	}

	ut, err := s.Db.UpdateSpeakerNames(id, names)
	if err != nil || ut == nil {
		log.Error().Err(err).Msgf("Error updating speaker names of transcription %v", id)
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}

	s.BroadcastTranscription(ut)
	return c.JSON(ut)
}

// speakerLabelPattern matches the labels diarization produces ("SPEAKER_00").
var speakerLabelPattern = regexp.MustCompile(`^SPEAKER_\d{2,3}$`)

// segmentSpeakerChange reassigns one segment. Start must match the segment's start
// time, so a correction made on a stale copy cannot land on a different segment.
type segmentSpeakerChange struct {
	Index   int     `json:"index"`
	Start   float64 `json:"start"`
	Speaker string  `json:"speaker"`
}

// handleUpdateSegmentSpeakers corrects the speaker of individual segments, for when
// diarization attributed a sentence to the wrong person. Translations are copied
// segment by segment from the original, so the same segment in every translation
// is corrected along with it.
func (s *Server) handleUpdateSegmentSpeakers(c *fiber.Ctx) error {
	id := c.Params("id")
	t := s.Db.GetTranscription(id)
	if t == nil {
		log.Warn().Msgf("Transcription with id %v not found", id)
		return fiber.NewError(fiber.StatusNotFound, "Not found")
	}

	var changes []segmentSpeakerChange
	if err := json.Unmarshal(c.Body(), &changes); err != nil || len(changes) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Body must be a non-empty JSON array of {index, start, speaker}")
	}

	const startTolerance = 0.001 // seconds
	paths := map[string]string{}
	for _, change := range changes {
		if !speakerLabelPattern.MatchString(change.Speaker) {
			return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("Invalid speaker label %q", change.Speaker))
		}
		if change.Index < 0 || change.Index >= len(t.Result.Segments) ||
			math.Abs(t.Result.Segments[change.Index].Start-change.Start) > startTolerance {
			return fiber.NewError(fiber.StatusConflict, fmt.Sprintf("Segment %d has changed, reload and try again", change.Index))
		}
		paths[fmt.Sprintf("result.segments.%d.speaker", change.Index)] = change.Speaker

		for ti, translation := range t.Translations {
			segments := translation.Result.Segments
			if change.Index < len(segments) && math.Abs(segments[change.Index].Start-change.Start) <= startTolerance {
				paths[fmt.Sprintf("translations.%d.result.segments.%d.speaker", ti, change.Index)] = change.Speaker
			}
		}
	}

	ut, err := s.Db.UpdateSegmentSpeakers(id, paths)
	if err != nil || ut == nil {
		log.Error().Err(err).Msgf("Error updating segment speakers of transcription %v", id)
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}

	s.BroadcastTranscription(ut)
	return c.JSON(ut)
}

// mergeSpeakersRequest joins the speakers in From into Into.
type mergeSpeakersRequest struct {
	From []string `json:"from"`
	Into string   `json:"into"`
}

// handleMergeSpeakers joins speakers that diarization split apart (the same person
// recognised as two voices, e.g. after a microphone change). Every segment of the
// merged speakers, in the original and in all translations, is relabelled to the
// target speaker, and the merged speakers' names are dropped.
func (s *Server) handleMergeSpeakers(c *fiber.Ctx) error {
	id := c.Params("id")
	t := s.Db.GetTranscription(id)
	if t == nil {
		log.Warn().Msgf("Transcription with id %v not found", id)
		return fiber.NewError(fiber.StatusNotFound, "Not found")
	}

	var req mergeSpeakersRequest
	if err := json.Unmarshal(c.Body(), &req); err != nil || len(req.From) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Body must be {from: [labels], into: label}")
	}

	labels := map[string]bool{}
	for _, segment := range t.Result.Segments {
		labels[segment.Speaker] = true
	}
	merged := map[string]bool{}
	for _, label := range append(req.From, req.Into) {
		if label == "" || !labels[label] {
			return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("Unknown speaker label %q", label))
		}
	}
	for _, label := range req.From {
		if label == req.Into {
			return fiber.NewError(fiber.StatusBadRequest, "Cannot join a speaker into itself")
		}
		merged[label] = true
	}

	paths := map[string]string{}
	for i, segment := range t.Result.Segments {
		if merged[segment.Speaker] {
			paths[fmt.Sprintf("result.segments.%d.speaker", i)] = req.Into
		}
	}
	for ti, translation := range t.Translations {
		for i, segment := range translation.Result.Segments {
			if merged[segment.Speaker] {
				paths[fmt.Sprintf("translations.%d.result.segments.%d.speaker", ti, i)] = req.Into
			}
		}
	}

	if _, err := s.Db.UpdateSegmentSpeakers(id, paths); err != nil {
		log.Error().Err(err).Msgf("Error merging speakers of transcription %v", id)
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}

	// The merged labels no longer occur, so their names would only linger.
	names := map[string]string{}
	for label, name := range t.SpeakerNames {
		if !merged[label] {
			names[label] = name
		}
	}
	ut, err := s.Db.UpdateSpeakerNames(id, names)
	if err != nil || ut == nil {
		log.Error().Err(err).Msgf("Error updating speaker names of transcription %v", id)
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}

	s.BroadcastTranscription(ut)
	return c.JSON(ut)
}
