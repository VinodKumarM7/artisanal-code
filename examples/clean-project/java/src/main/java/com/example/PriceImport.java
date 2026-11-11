package com.example;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class PriceImport {
    public static void main(String[] args) throws IOException {
        System.out.println(Files.readString(Path.of(args[0])));
    }
}
