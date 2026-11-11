public with sharing class InventoryService {
    private final IInventoryRepository repository;

    public InventoryService(IInventoryRepository repository) {
        this.repository = repository;
    }

    public Integer countProducts() {
        try {
            return repository.findAll().size();
        } catch (QueryException e) {
            System.debug('Query failed: ' + e.getMessage());
        }
        return 0;
    }
}
