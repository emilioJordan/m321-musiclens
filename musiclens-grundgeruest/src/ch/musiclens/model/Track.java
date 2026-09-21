package ch.musiclens.model;

public record Track(String title, Artist artist, int playCount, int durationSeconds) {
    public int totalListeningMinutes() {
        return (playCount * durationSeconds) / 60;
    }
}
