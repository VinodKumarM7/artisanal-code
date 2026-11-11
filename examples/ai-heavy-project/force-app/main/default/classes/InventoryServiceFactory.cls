public with sharing class InventoryServiceFactory {
    public static InventoryService create() {
        return new InventoryService(new InventoryRepository());
    }
}
