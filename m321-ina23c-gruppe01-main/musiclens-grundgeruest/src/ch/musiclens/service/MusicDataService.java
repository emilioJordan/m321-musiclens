package ch.musiclens.service;

import ch.musiclens.model.Artist;
import ch.musiclens.model.Track;
import java.util.List;

public class MusicDataService {
    private final List<Track> tracks;

    public MusicDataService() {
        Artist weeknd = new Artist("The Weeknd", "Pop");
        Artist travis = new Artist("Travis Scott", "Hip-Hop");
        Artist drake = new Artist("Drake", "Hip-Hop");
        Artist tame = new Artist("Tame Impala", "Psychedelic Pop");
        Artist kendrick = new Artist("Kendrick Lamar", "Hip-Hop");

        tracks = List.of(
                new Track("Blinding Lights", weeknd, 24, 200),
                new Track("FE!N", travis, 18, 191),
                new Track("Passionfruit", drake, 16, 299),
                new Track("The Less I Know The Better", tame, 14, 216),
                new Track("Money Trees", kendrick, 12, 386)
        );
    }

    public List<Track> getTracks() {
        return tracks;
    }

    public void synchronize() {
        System.out.println("\nSynchronisiere Spotify-Daten ...");
        System.out.println("Top-Tracks geladen.");
        System.out.println("Top-Artists geladen.");
        System.out.println("Zuletzt gehörte Songs geladen.");
        System.out.println("Synchronisation abgeschlossen (Mock).");
    }
}
