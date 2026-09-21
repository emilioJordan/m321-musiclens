package ch.musiclens.service;

import ch.musiclens.model.Artist;
import ch.musiclens.model.Recap;
import ch.musiclens.model.Track;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class StatisticsService {
    private final MusicDataService data;
    private final List<Recap> history = new ArrayList<>();

    public StatisticsService(MusicDataService data) {
        this.data = data;
    }

    public void showDashboard() {
        List<Track> tracks = sortedTracks();

        System.out.println("\n=== MUSICLENS DASHBOARD ===");
        System.out.println("Gesamte Hörzeit: " + totalMinutes(tracks) + " Minuten");
        System.out.println("\nTop Tracks:");

        for (int i = 0; i < tracks.size(); i++) {
            Track t = tracks.get(i);
            System.out.printf("%d. %s - %s (%d Plays)%n",
                    i + 1, t.title(), t.artist().name(), t.playCount());
        }

        System.out.println("\nTop Artists:");
        List<Artist> artists = topArtists(tracks);
        for (int i = 0; i < artists.size(); i++) {
            System.out.printf("%d. %s (%s)%n",
                    i + 1, artists.get(i).name(), artists.get(i).genre());
        }
    }

    public Recap createRecap(LocalDate from, LocalDate to) {
        if (to.isBefore(from)) {
            throw new IllegalArgumentException("Enddatum darf nicht vor dem Startdatum liegen.");
        }

        List<Track> tracks = sortedTracks();
        Recap recap = new Recap(from, to, tracks, topArtists(tracks), totalMinutes(tracks));
        history.add(recap);
        return recap;
    }

    public void printRecap(Recap recap) {
        System.out.printf("%n=== RECAP %s bis %s ===%n", recap.from(), recap.to());
        System.out.println("Hörzeit: " + recap.totalListeningMinutes() + " Minuten");
        System.out.println("Top Tracks:");
        for (int i = 0; i < recap.topTracks().size(); i++) {
            Track t = recap.topTracks().get(i);
            System.out.printf("%d. %s - %s%n", i + 1, t.title(), t.artist().name());
        }
    }

    public void compare(Recap a, Recap b) {
        int diff = b.totalListeningMinutes() - a.totalListeningMinutes();

        System.out.println("\n=== ZEITRAUM-VERGLEICH ===");
        System.out.printf("A: %s bis %s%n", a.from(), a.to());
        System.out.printf("B: %s bis %s%n", b.from(), b.to());
        System.out.println("Hörzeit-Differenz: " + (diff >= 0 ? "+" : "") + diff + " Minuten");
        System.out.println("Top Track A: " + a.topTracks().get(0).title());
        System.out.println("Top Track B: " + b.topTracks().get(0).title());
    }

    public List<Recap> getHistory() {
        return List.copyOf(history);
    }

    private List<Track> sortedTracks() {
        return data.getTracks().stream()
                .sorted(Comparator.comparingInt(Track::playCount).reversed())
                .toList();
    }

    private int totalMinutes(List<Track> tracks) {
        return tracks.stream().mapToInt(Track::totalListeningMinutes).sum();
    }

    private List<Artist> topArtists(List<Track> tracks) {
        Map<Artist, Integer> counts = new LinkedHashMap<>();
        for (Track t : tracks) {
            counts.merge(t.artist(), t.playCount(), Integer::sum);
        }

        return counts.entrySet().stream()
                .sorted(Map.Entry.<Artist, Integer>comparingByValue().reversed())
                .map(Map.Entry::getKey)
                .limit(5)
                .toList();
    }
}
