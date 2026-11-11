public with sharing class InventoryRepository implements IInventoryRepository {
    public List<Product2> findAll() {
        return [SELECT Id, Name FROM Product2 LIMIT 200];
    }
}
