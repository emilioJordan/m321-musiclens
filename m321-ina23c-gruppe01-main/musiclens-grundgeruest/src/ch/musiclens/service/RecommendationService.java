package ch.musiclens.service;

import ch.musiclens.model.Track;
import java.util.List;

public class RecommendationService {
    public void showRecommendations(List<Track> tracks) {
        System.out.println("\n=== EMPFEHLUNGEN ===");

        boolean hipHop = tracks.stream()
                .anyMatch(t -> t.artist().genre().equalsIgnoreCase("Hip-Hop"));
        boolean pop = tracks.stream()
                .anyMatch(t -> t.artist().genre().contains("Pop"));

        if (hipHop) {
            System.out.println("- J. Cole - No Role Modelz");
            System.out.println("- Tyler, The Creator - EARFQUAKE");
        }
        if (pop) {
            System.out.println("- Arctic Monkeys - Do I Wanna Know?");
            System.out.println("- Glass Animals - Heat Waves");
        }

        System.out.println("Aktuell noch lokale, regelbasierte Mock-Empfehlungen.");
    }
}
