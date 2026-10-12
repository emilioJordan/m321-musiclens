package ch.musiclens.model;

import java.time.LocalDate;
import java.util.List;

public record Recap(
        LocalDate from,
        LocalDate to,
        List<Track> topTracks,
        List<Artist> topArtists,
        int totalListeningMinutes
) {
}
