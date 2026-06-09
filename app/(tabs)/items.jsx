import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Image } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Droplet, Trash2, Plus, Minus } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiFetch } from '../../lib/api';

export default function ItemsScreen() {
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [pendingReturns, setPendingReturns] = useState(0);

  const timeoutRefs = useRef({});
  const pendingUpdates = useRef({});

  useFocusEffect(
    useCallback(() => {
      const fetchItems = async () => {
        try {
          const response = await apiFetch('/api/products');
          const data = await response.json();
          if (data.success) {
            setItems(data.products || []);
          }
        } catch (err) {
          console.error('Error fetching items:', err);
        } finally {
          setIsLoading(false);
        }
      };

      const loadCartAndProfile = async () => {
        try {
          // Fast optimistic update from local storage
          const cached = await AsyncStorage.getItem('cart');
          if (cached) setCart(JSON.parse(cached));
          else setCart([]);

          const cartRes = await apiFetch('/api/cart');
          if (cartRes.ok) {
            const cartData = await cartRes.json();
            if (cartData.success) {
              setCart(cartData.items || []);
              await AsyncStorage.setItem('cart', JSON.stringify(cartData.items || []));
            }
          }

          const profileRes = await apiFetch('/api/user/profile');
          if (profileRes.ok) {
            const profileData = await profileRes.json();
            if (profileData.profile) setCustomer(profileData.profile);
          }

          const returnsRes = await apiFetch('/api/user/return-request');
          if (returnsRes.ok) {
            const returnsData = await returnsRes.json();
            if (returnsData.requests) {
              const count = returnsData.requests
                .filter(r => r.status === 'REQUESTED')
                .reduce((s, r) => s + r.quantity, 0);
              setPendingReturns(count);
            }
          }
        } catch (err) {
          console.error('Error loading data:', err);
        }
      };

      fetchItems();
      loadCartAndProfile();
    }, [])
  );

  useEffect(() => {

    // Flush on unmount
    return () => {
      Object.keys(pendingUpdates.current).forEach(itemId => {
        const update = pendingUpdates.current[itemId];
        if (update) {
          if (timeoutRefs.current[itemId]) clearTimeout(timeoutRefs.current[itemId]);
          apiFetch('/api/cart', { method: 'POST', body: JSON.stringify(update) })
            .catch(e => console.error('Flush error', e));
        }
      });
    };
  }, []);

  const getItemQuantity = (itemId) => {
    const cartItem = cart.find(i => i.id === itemId);
    return cartItem ? cartItem.quantity : 0;
  };

  // Recalculate returnQuantity for all deposit items in a cart snapshot
  const calcReturnQtys = (cartSnapshot, customer, pendingReturns) => {
    const cih = customer?.cansInHand || 0;
    const pr = customer?.pendingReturned || 0;
    const explicitPR = pendingReturns || 0;
    let available = Math.max(0, cih - pr - explicitPR);

    return cartSnapshot.map(ci => {
      if ((ci.depositAmount || 0) > 0) {
        const returnQty = Math.min(ci.quantity, available);
        available -= returnQty;
        return { ...ci, returnQuantity: returnQty };
      }
      return { ...ci, returnQuantity: 0 };
    });
  };

  // Sync debounced update to server
  const syncToServer = (item, newQuantity, returnQuantity) => {
    const payload = { productId: item.id, quantity: newQuantity, returnQuantity };
    pendingUpdates.current[item.id] = payload;

    if (timeoutRefs.current[item.id]) clearTimeout(timeoutRefs.current[item.id]);
    timeoutRefs.current[item.id] = setTimeout(async () => {
      try {
        await apiFetch('/api/cart', { method: 'POST', body: JSON.stringify(payload) });
        delete pendingUpdates.current[item.id];
      } catch (err) {
        console.error('Error syncing cart:', err);
      }
    }, 300);
  };

  const changeQuantity = (item, delta, { immediate = false } = {}) => {
    setCart(prevCart => {
      const existing = prevCart.find(ci => ci.id === item.id);
      const currentQty = existing ? existing.quantity : 0;
      const newQty = Math.max(1, Math.min(100, currentQty + delta));

      let newCart;
      if (existing) {
        newCart = prevCart.map(ci => ci.id === item.id ? { ...ci, quantity: newQty } : ci);
      } else {
        newCart = [...prevCart, { ...item, quantity: newQty, returnQuantity: 0 }];
      }

      const withReturns = calcReturnQtys(newCart, customer, pendingReturns);
      AsyncStorage.setItem('cart', JSON.stringify(withReturns)).catch(() => {});

      const target = withReturns.find(ci => ci.id === item.id);
      if (immediate) {
        // Sync immediately (new item or single-product redirect)
        if (timeoutRefs.current[item.id]) clearTimeout(timeoutRefs.current[item.id]);
        const payload = { productId: item.id, quantity: newQty, returnQuantity: target?.returnQuantity || 0 };
        pendingUpdates.current[item.id] = payload;
        apiFetch('/api/cart', { method: 'POST', body: JSON.stringify(payload) })
          .then(() => { delete pendingUpdates.current[item.id]; })
          .catch(e => console.error(e));
      } else {
        syncToServer(item, newQty, target?.returnQuantity || 0);
      }

      return withReturns;
    });
  };

  const removeFromCart = (itemId) => {
    setCart(prevCart => {
      const newCart = prevCart.filter(ci => ci.id !== itemId);
      AsyncStorage.setItem('cart', JSON.stringify(newCart)).catch(() => {});
      if (timeoutRefs.current[itemId]) clearTimeout(timeoutRefs.current[itemId]);
      apiFetch('/api/cart', { method: 'POST', body: JSON.stringify({ productId: itemId, quantity: 0 }) })
        .catch(e => console.error('Error removing cart item:', e));
      return newCart;
    });
  };

  if (isLoading) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: '#f3f7fb' }} contentContainerStyle={{ padding: 16 }}>
        <View style={{ width: 140, height: 32, backgroundColor: '#e5e7eb', borderRadius: 8, marginBottom: 16 }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <View
              key={i}
              style={{
                width: '48%', backgroundColor: '#fff', borderRadius: 16,
                borderWidth: 1, borderColor: '#f3f4f6', marginBottom: 16,
                padding: 16
              }}
            >
              <View style={{ width: 80, height: 80, backgroundColor: '#f3f4f6', borderRadius: 8, alignSelf: 'center', marginBottom: 16 }} />
              <View style={{ width: '80%', height: 16, backgroundColor: '#f3f4f6', borderRadius: 4, marginBottom: 8 }} />
              <View style={{ width: '50%', height: 12, backgroundColor: '#f3f4f6', borderRadius: 4, marginBottom: 16 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 }}>
                <View style={{ width: 40, height: 20, backgroundColor: '#f3f4f6', borderRadius: 4 }} />
                <View style={{ width: 30, height: 12, backgroundColor: '#f3f4f6', borderRadius: 4 }} />
              </View>
              <View style={{ width: '100%', height: 36, backgroundColor: '#f3f4f6', borderRadius: 8 }} />
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#f3f7fb' }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold', color: '#000', marginBottom: 16 }}>Select Items</Text>

      {items.length === 0 ? (
        <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 32, alignItems: 'center', marginTop: 40 }}>
          <Droplet size={48} color="#9ca3af" />
          <Text style={{ fontSize: 18, fontWeight: '600', color: '#000', marginTop: 16 }}>No items available</Text>
          <Text style={{ color: '#6b7280', marginTop: 8 }}>Check back later for new items</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          {items.map((item) => {
            const quantity = getItemQuantity(item.id);
            const isSingleCatalogue = items.length === 1;

            return (
              <View
                key={item.id}
                style={{
                  width: '48%', backgroundColor: '#fff', borderRadius: 16,
                  borderWidth: 1, borderColor: '#e0f2fe', marginBottom: 16,
                  overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
                }}
              >
                {/* Image area */}
                <View style={{ padding: 16, alignItems: 'center', borderBottomWidth: 1, borderColor: '#f9fafb' }}>
                  {item.image ? (
                    <Image source={{ uri: item.image }} style={{ width: 80, height: 80 }} resizeMode="contain" />
                  ) : (
                    <View style={{ width: 80, height: 80, backgroundColor: '#e0f2fe', borderRadius: 40, alignItems: 'center', justifyContent: 'center' }}>
                      <Droplet size={32} color="#0ea5e9" />
                    </View>
                  )}
                </View>

                {/* Info area */}
                <View style={{ padding: 14 }}>
                  <Text style={{ fontWeight: '600', color: '#000', fontSize: 15 }} numberOfLines={1}>{item.name}</Text>
                  <Text style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }} numberOfLines={2}>{item.description}</Text>

                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 14 }}>
                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#000' }}>₹{Number(item.price).toFixed(2)}</Text>
                    <Text style={{ fontSize: 11, color: '#9ca3af' }}>{item.unit}</Text>
                  </View>

                  {!item.inStock ? (
                    <View style={{ paddingVertical: 9, backgroundColor: '#f3f4f6', borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#e5e7eb' }}>
                      <Text style={{ color: '#6b7280', fontWeight: '500' }}>Out of Stock</Text>
                    </View>
                  ) : item.hasPendingDeposit ? (
                    <View style={{ paddingVertical: 9, backgroundColor: '#fef9c3', borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#fde68a' }}>
                      <Text style={{ color: '#92400e', fontWeight: '500', fontSize: 12 }}>Pending Approval</Text>
                    </View>
                  ) : quantity > 0 ? (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        onPress={() => router.push('/(tabs)/cart')}
                        style={{ flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#e5e7eb', backgroundColor: '#fff' }}
                      >
                        <Text style={{ color: '#374151', fontWeight: '600', fontSize: 13 }}>Go to cart</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => removeFromCart(item.id)}
                        style={{ paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#fff5f5', borderRadius: 8, borderWidth: 1, borderColor: '#fecaca', alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Trash2 size={16} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      onPress={() => {
                        changeQuantity(item, 1, { immediate: true });
                        if (isSingleCatalogue) router.push('/(tabs)/cart');
                      }}
                      style={{ paddingVertical: 10, backgroundColor: '#0ea5e9', borderRadius: 8, alignItems: 'center' }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Add to cart</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
