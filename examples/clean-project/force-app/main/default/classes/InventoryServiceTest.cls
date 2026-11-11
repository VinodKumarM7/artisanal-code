@isTest
private class InventoryServiceTest {
    @isTest
    static void countsProducts() {
        insert new Product2(Name = 'Pen');
        Integer productCount = new InventoryService().countProducts();
        System.assertEquals(1, productCount);
    }
}
