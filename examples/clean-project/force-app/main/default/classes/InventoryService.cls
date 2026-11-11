public with sharing class InventoryService {
    public Integer countProducts() {
        return [SELECT COUNT() FROM Product2 WITH USER_MODE];
    }
}
