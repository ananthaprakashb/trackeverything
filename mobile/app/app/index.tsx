import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { addSteps, clearToken, Dashboard, getDashboard, getMe, getToken, saveToken, User } from '@/src/api';

WebBrowser.maybeCompleteAuthSession();

const API_URL = String(Constants.expoConfig?.extra?.apiUrl || '').replace(/\/$/, '');
const CALLBACK_URL = 'trackeverything://auth';

export default function HomeScreen() {
  const [user, setUser] = useState<User | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [steps, setSteps] = useState('');

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) {
      setUser(null);
      setDashboard(null);
      setLoading(false);
      return;
    }
    try {
      const [nextUser, nextDashboard] = await Promise.all([getMe(), getDashboard()]);
      setUser(nextUser);
      setDashboard(nextDashboard);
    } catch (error) {
      await clearToken();
      setUser(null);
      setDashboard(null);
      Alert.alert('Session ended', error instanceof Error ? error.message : 'Please sign in again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const subscription = Linking.addEventListener('url', async ({ url }) => {
      const parsed = Linking.parse(url);
      const token = typeof parsed.queryParams?.session === 'string' ? parsed.queryParams.session : '';
      const error = typeof parsed.queryParams?.error === 'string' ? parsed.queryParams.error : '';
      if (error) Alert.alert('Sign-in failed', error);
      if (token) {
        await saveToken(token);
        setLoading(true);
        await load();
      }
    });
    return () => subscription.remove();
  }, [load]);

  const totalSteps = useMemo(
    () => dashboard?.members.reduce((total, member) => total + Number(member.steps || 0), 0) || 0,
    [dashboard],
  );

  async function signIn() {
    const url = `${API_URL}/auth/mobile/google?redirect_uri=${encodeURIComponent(CALLBACK_URL)}`;
    const result = await WebBrowser.openAuthSessionAsync(url, CALLBACK_URL);
    if (result.type === 'success') {
      const parsed = Linking.parse(result.url);
      const token = typeof parsed.queryParams?.session === 'string' ? parsed.queryParams.session : '';
      if (token) {
        await saveToken(token);
        setLoading(true);
        await load();
      }
    }
  }

  async function submitSteps() {
    const value = Number(steps);
    if (!Number.isInteger(value) || value < 0 || value > 200000) {
      Alert.alert('Invalid steps', 'Enter a whole number between 0 and 200,000.');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    try {
      await addSteps(value, date);
      setSteps('');
      setRefreshing(true);
      await load();
    } catch (error) {
      Alert.alert('Update failed', error instanceof Error ? error.message : 'Unable to save steps.');
    }
  }

  if (loading) {
    return <SafeAreaView style={styles.center}><ActivityIndicator size="large" /><Text>Loading Track Everything…</Text></SafeAreaView>;
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.signInCard}>
          <Text style={styles.eyebrow}>TRACK EVERYTHING</Text>
          <Text style={styles.title}>One app for shared progress.</Text>
          <Text style={styles.body}>Create a group, invite members, track projects, and sync daily steps from Android Health Connect or Apple Health.</Text>
          <Pressable style={styles.primaryButton} onPress={signIn}><Text style={styles.primaryButtonText}>Continue with Google</Text></Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>YOUR GROUP</Text><Text style={styles.heading}>{user.groupName}</Text><Text style={styles.muted}>{user.name} · {user.role}</Text></View>
          <Pressable onPress={async () => { await clearToken(); setUser(null); setDashboard(null); }}><Text style={styles.link}>Sign out</Text></Pressable>
        </View>

        <View style={styles.metricCard}><Text style={styles.metricLabel}>Group steps today</Text><Text style={styles.metricValue}>{totalSteps.toLocaleString()}</Text><Text style={styles.metricNote}>{dashboard?.members.length || 0} active members</Text></View>

        <View style={styles.card}>
          <Text style={styles.heading}>Update today’s steps</Text>
          <Text style={styles.muted}>Manual updates work immediately. Device Health sync will use the same secure account.</Text>
          <TextInput value={steps} onChangeText={setSteps} keyboardType="number-pad" placeholder="8,500" style={styles.input} />
          <Pressable style={styles.primaryButton} onPress={submitSteps}><Text style={styles.primaryButtonText}>Save steps</Text></Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.heading}>Device Health</Text>
          <Text style={styles.body}>Android: Health Connect</Text>
          <Text style={styles.body}>iPhone: Apple Health</Text>
          <Text style={styles.muted}>The native adapters will request only step-count access and upload the aggregated daily total.</Text>
          <Pressable style={styles.secondaryButton} onPress={() => Alert.alert('Coming next', 'Native Health Connect and HealthKit adapters are the next implementation step.')}><Text style={styles.secondaryButtonText}>Connect device health</Text></Pressable>
        </View>

        <Text style={styles.eyebrow}>MEMBERS</Text>
        {dashboard?.members.map(member => (
          <View style={styles.memberRow} key={member.memberId}>
            <View><Text style={styles.memberName}>{member.name || member.memberId}</Text><Text style={styles.muted}>Goal {Number(member.goal || 0).toLocaleString()}</Text></View>
            <Text style={styles.memberSteps}>{Number(member.steps || 0).toLocaleString()}</Text>
          </View>
        ))}

        <Text style={styles.eyebrow}>PROJECTS</Text>
        {dashboard?.projects.map(project => (
          <View style={styles.memberRow} key={project.projectId}>
            <View><Text style={styles.memberName}>{project.name}</Text><Text style={styles.muted}>{project.type}</Text></View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f3f6f4' },
  center: { flex: 1, gap: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f3f6f4' },
  content: { padding: 20, gap: 16 },
  signInCard: { margin: 20, marginTop: 80, padding: 28, gap: 18, borderRadius: 28, backgroundColor: '#ffffff' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  card: { padding: 20, gap: 14, borderRadius: 22, backgroundColor: '#ffffff' },
  metricCard: { padding: 24, borderRadius: 22, backgroundColor: '#17211c' },
  eyebrow: { color: '#1f7a52', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, marginTop: 8 },
  title: { color: '#17211c', fontSize: 38, lineHeight: 42, fontWeight: '800' },
  heading: { color: '#17211c', fontSize: 22, fontWeight: '800' },
  body: { color: '#33413a', fontSize: 16, lineHeight: 24 },
  muted: { color: '#68756e', fontSize: 14, lineHeight: 20 },
  link: { color: '#1f7a52', fontWeight: '700', paddingVertical: 8 },
  metricLabel: { color: '#b9c9c0', fontSize: 14 },
  metricValue: { color: '#ffffff', fontSize: 44, fontWeight: '900', marginVertical: 8 },
  metricNote: { color: '#b9c9c0' },
  input: { borderWidth: 1, borderColor: '#dce5df', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#ffffff', fontSize: 20 },
  primaryButton: { alignItems: 'center', borderRadius: 999, paddingVertical: 15, paddingHorizontal: 20, backgroundColor: '#17211c' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  secondaryButton: { alignItems: 'center', borderRadius: 999, paddingVertical: 14, paddingHorizontal: 20, borderWidth: 1, borderColor: '#dce5df' },
  secondaryButtonText: { color: '#17211c', fontWeight: '800' },
  memberRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 14, padding: 18, borderRadius: 18, backgroundColor: '#ffffff' },
  memberName: { color: '#17211c', fontSize: 16, fontWeight: '800' },
  memberSteps: { color: '#17211c', fontSize: 24, fontWeight: '900' },
});
