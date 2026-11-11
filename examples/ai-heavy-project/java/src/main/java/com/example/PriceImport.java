package com.example;

import java.nio.file.Files;
import java.nio.file.Path;

public class PriceImport {
    public static void main(String[] args) {
        try {
            System.out.println(Files.readString(Path.of(args[0])));
        } catch (Exception e) {
        }
    }
}
