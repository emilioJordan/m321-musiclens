package ch.musiclens;

import ch.musiclens.model.Recap;
import ch.musiclens.service.MusicDataService;
import ch.musiclens.service.RecommendationService;
import ch.musiclens.service.StatisticsService;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Scanner;

public class Main {
    private static final Scanner scanner = new Scanner(System.in);

    public static void main(String[] args) {
        MusicDataService data = new MusicDataService();
        StatisticsService stats = new StatisticsService(data);
        RecommendationService recommendations = new RecommendationService();

        System.out.println("MusicLens gestartet.");
        boolean running = true;

        while (running) {
            System.out.println("""

                    === MENÜ ===
                    1 - Dashboard
                    2 - Spotify-Daten synchronisieren (Mock)
                    3 - Recap erstellen
                    4 - Letzte zwei Recaps vergleichen
                    5 - Empfehlungen
                    6 - Recap-Verlauf
                    0 - Beenden
                    """);
            System.out.print("Auswahl: ");

            switch (scanner.nextLine().trim()) {
                case "1" -> stats.showDashboard();
                case "2" -> data.synchronize();
                case "3" -> createRecap(stats);
                case "4" -> compare(stats);
                case "5" -> recommendations.showRecommendations(data.getTracks());
                case "6" -> showHistory(stats);
                case "0" -> running = false;
                default -> System.out.println("Ungültige Auswahl.");
            }
        }

        System.out.println("MusicLens beendet.");
    }

    private static void createRecap(StatisticsService stats) {
        try {
            LocalDate from = readDate("Startdatum (YYYY-MM-DD): ");
            LocalDate to = readDate("Enddatum   (YYYY-MM-DD): ");
            stats.printRecap(stats.createRecap(from, to));
        } catch (IllegalArgumentException e) {
            System.out.println("Fehler: " + e.getMessage());
        }
    }

    private static void compare(StatisticsService stats) {
        List<Recap> history = stats.getHistory();
        if (history.size() < 2) {
            System.out.println("Erstelle zuerst mindestens zwei Recaps.");
            return;
        }
        stats.compare(history.get(history.size() - 2), history.get(history.size() - 1));
    }

    private static void showHistory(StatisticsService stats) {
        List<Recap> history = stats.getHistory();
        System.out.println("\n=== RECAP-VERLAUF ===");
        if (history.isEmpty()) {
            System.out.println("Noch keine Recaps erstellt.");
            return;
        }
        for (int i = 0; i < history.size(); i++) {
            Recap recap = history.get(i);
            System.out.printf("%d. %s bis %s | %d Minuten%n",
                    i + 1, recap.from(), recap.to(), recap.totalListeningMinutes());
        }
    }

    private static LocalDate readDate(String prompt) {
        while (true) {
            System.out.print(prompt);
            try {
                return LocalDate.parse(scanner.nextLine().trim());
            } catch (DateTimeParseException e) {
                System.out.println("Bitte Datum im Format YYYY-MM-DD eingeben.");
            }
        }
    }
}
